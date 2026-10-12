import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import '../../shared/fmg/fmg_management.dart';
import '../../shared/theme/theme.dart';
import 'fmg_control_status.dart';
import 'fmg_edit_form.dart';
import 'fmg_ui_labels.dart';

/// Repository browsing, project tasks and reviews share Desktop's authoritative project models.
class FmgRepositoryPage extends HookConsumerWidget {
  const FmgRepositoryPage({
    super.key,
    required this.management,
    required this.projectAddress,
    required this.repository,
  });
  final FmgManagement management;
  final String projectAddress;
  final Map<String, dynamic> repository;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final currentManagement = ref.watch(fmgManagementProvider);
    final tab = useState(0);
    final refresh = useState(0);
    final offset = useState(0);
    final busy = useState(false);
    final error = useState<String?>(null);
    final target = {
      'projectAddress': projectAddress,
      'repoAddress': repository['repoAddress'],
    };
    final future = useMemoized(
      () => management.read(
        switch (tab.value) {
          0 => 'repositories.snapshot',
          1 => 'issues.list',
          _ => 'reviews.list',
        },
        {...target, if (tab.value != 0) 'offset': offset.value},
      ),
      [management, tab.value, refresh.value, offset.value],
    );
    final snapshot = useFuture(future);
    final data = snapshot.connectionState == ConnectionState.done
        ? snapshot.data
        : null;
    Future<void> form(
      String action,
      String title,
      List<FmgEditField> fields, [
      Map<String, dynamic> extra = const {},
      Map<String, dynamic> initial = const {},
    ]) async {
      final revisionKey = extra.containsKey('expectedUpdatedAt')
          ? 'expectedUpdatedAt'
          : extra.containsKey('expectedCommit')
          ? 'expectedCommit'
          : null;
      final result = await Navigator.push<Map<String, dynamic>>(
        context,
        MaterialPageRoute(
          builder: (_) => FmgEditForm(
            management: management,
            draftId:
                '${repository['repoAddress']}:$action:${extra['issueId'] ?? extra['reviewId'] ?? ''}',
            title: title,
            fields: fields,
            initial: {
              ...initial,
              '_baseRevision': revisionKey == null ? null : extra[revisionKey],
            },
            onSave: (values) {
              final revision = values.remove('_baseRevision');
              final input = <String, dynamic>{...target, ...extra, ...values};
              if (revisionKey != null)
                input[revisionKey] = revision ?? extra[revisionKey];
              return management.mutate(action, input);
            },
          ),
        ),
      );
      if (context.mounted && result != null) refresh.value++;
    }

    Future<void> file(String path) async {
      busy.value = true;
      error.value = null;
      try {
        final result = await management.read('repositories.file', {
          ...target,
          'path': path,
        });
        if (context.mounted) {
          await Navigator.push<void>(
            context,
            MaterialPageRoute(
              builder: (_) => Scaffold(
                appBar: AppBar(title: Text(path)),
                body: SingleChildScrollView(
                  padding: const EdgeInsets.all(Grid.gutter),
                  child: SelectableText(
                    '${result['content'] ?? '텍스트 내용을 표시할 수 없습니다.'}${result['truncated'] == true ? '\n… 내용이 길어 일부만 표시됩니다.' : ''}',
                  ),
                ),
              ),
            ),
          );
        }
      } catch (reason) {
        if (context.mounted) error.value = fmgDisplayError(reason);
      } finally {
        if (context.mounted) busy.value = false;
      }
    }

    Future<void> clone() async {
      busy.value = true;
      error.value = null;
      try {
        await management.mutate('repositories.clone', target);
        if (context.mounted) error.value = 'PC의 프로젝트 작업 공간에 저장소를 연결했습니다.';
      } catch (reason) {
        if (context.mounted) error.value = fmgDisplayError(reason);
      } finally {
        if (context.mounted) busy.value = false;
      }
    }

    if (currentManagement?.rpc.scope != management.rpc.scope) {
      return Scaffold(
        appBar: AppBar(title: const Text('저장소')),
        body: const Center(child: Text('계정이나 커뮤니티가 변경됐습니다. 다시 여세요.')),
      );
    }
    return Scaffold(
      appBar: AppBar(
        title: Text(repository['name'] as String),
        actions: [
          IconButton(
            tooltip: '새로 고침',
            onPressed: () => refresh.value++,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(Grid.gutter),
        children: [
          FmgControlStatus(
            management: management,
            onConnected: () => refresh.value++,
          ),
          SegmentedButton<int>(
            segments: const [
              ButtonSegment(value: 0, label: Text('코드')),
              ButtonSegment(value: 1, label: Text('할 일')),
              ButtonSegment(value: 2, label: Text('검토')),
            ],
            selected: {tab.value},
            onSelectionChanged: (value) {
              offset.value = 0;
              tab.value = value.single;
            },
          ),
          const SizedBox(height: Grid.sm),
          if (snapshot.connectionState == ConnectionState.waiting || busy.value)
            const LinearProgressIndicator(),
          if (snapshot.hasError || error.value != null)
            Text(
              error.value ?? fmgDisplayError(snapshot.error),
              style: TextStyle(color: context.colors.error),
            ),
          if (tab.value == 0) ...[
            if (repository['owner'] == management.rpc.owner)
              Wrap(
                spacing: Grid.xs,
                children: [
                  OutlinedButton(
                    onPressed: busy.value ? null : clone,
                    child: const Text('PC 작업 공간 연결'),
                  ),
                  OutlinedButton(
                    onPressed: () => form(
                      'repositories.create_branch',
                      '브랜치 만들기',
                      const [
                        FmgEditField('sourceBranch', '기준 브랜치', required: true),
                        FmgEditField(
                          'expectedCommit',
                          '현재 기준 커밋',
                          required: true,
                        ),
                        FmgEditField('branch', '새 브랜치', required: true),
                      ],
                      {},
                      {
                        'sourceBranch': repository['defaultBranch'],
                        'expectedCommit':
                            (data?['latestCommit'] as Map?)?['hash'] ?? '',
                      },
                    ),
                    child: const Text('브랜치 만들기'),
                  ),
                ],
              ),
            if (data?['latestCommit'] is Map)
              SelectableText(
                '최근 커밋 · ${data!['latestCommit']['hash']}\n${data['latestCommit']['subject']}',
              ),
            for (final branch in data?['branches'] as List? ?? [])
              ListTile(
                leading: const Icon(Icons.account_tree_outlined),
                title: Text(branch['name'] as String),
                subtitle: Text(branch['commit'] as String),
                trailing:
                    repository['owner'] == management.rpc.owner &&
                        branch['name'] != repository['defaultBranch']
                    ? IconButton(
                        tooltip: '브랜치 삭제',
                        icon: const Icon(Icons.delete_outline),
                        onPressed: () => form(
                          'repositories.delete_branch',
                          '브랜치 삭제',
                          const [
                            FmgEditField(
                              'confirmation',
                              '삭제할 브랜치 이름을 확인하고 입력',
                              required: true,
                            ),
                          ],
                          {
                            'branch': branch['name'],
                            'expectedCommit': branch['commit'],
                          },
                        ),
                      )
                    : null,
              ),
            for (final raw in data?['files'] as List? ?? [])
              ListTile(
                leading: Icon(
                  raw['kind'] == 'directory'
                      ? Icons.folder_outlined
                      : Icons.code,
                ),
                title: Text(raw['path'] as String),
                onTap: busy.value ? null : () => file(raw['path'] as String),
              ),
          ],
          if (tab.value == 1) ...[
            FilledButton.icon(
              onPressed: () => form(
                'issues.create',
                '할 일 만들기',
                const [
                  FmgEditField('title', '제목', required: true),
                  FmgEditField('body', '내용', multiline: true),
                  FmgEditField(
                    'category',
                    '종류',
                    options: {
                      'issue': '할 일',
                      'change-request': '변경 요청',
                      'improvement': '개선',
                    },
                  ),
                ],
                {},
                {'category': 'issue'},
              ),
              icon: const Icon(Icons.add),
              label: const Text('할 일 만들기'),
            ),
            for (final issue in data?['issues'] as List? ?? [])
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(Grid.sm),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        issue['title'] as String,
                        style: context.textTheme.titleMedium,
                      ),
                      Text(issue['status'] as String),
                      if (issue['author'] == management.rpc.owner ||
                          repository['owner'] == management.rpc.owner)
                        Wrap(
                          children: [
                            TextButton(
                              onPressed: () => form(
                                'issues.status',
                                '할 일 상태 변경',
                                const [
                                  FmgEditField(
                                    'status',
                                    '상태',
                                    options: {
                                      'open': '열기',
                                      'resolved': '완료',
                                      'closed': '닫기',
                                      'draft': '검토 대기',
                                    },
                                  ),
                                ],
                                {
                                  'issueId': issue['id'],
                                  'expectedUpdatedAt': issue['updatedAt'],
                                },
                                {'status': 'open'},
                              ),
                              child: const Text('상태 변경'),
                            ),
                            TextButton(
                              onPressed: () => form(
                                'issues.assign',
                                '담당자 배정',
                                const [
                                  FmgEditField(
                                    'assignees',
                                    '담당자 공개키',
                                    multiline: true,
                                    required: true,
                                    help: '사용자 또는 에이전트 공개키를 줄마다 입력하세요.',
                                  ),
                                ],
                                {
                                  'issueId': issue['id'],
                                  'expectedUpdatedAt': issue['updatedAt'],
                                },
                              ),
                              child: const Text('담당자 배정'),
                            ),
                          ],
                        ),
                      SelectableText(issue['content'] as String),
                      if (issue['contentTruncated'] == true)
                        const Text('긴 내용은 일부만 표시됩니다. 전체 내용은 PC에서 확인하세요.'),
                      for (final comment in issue['comments'] as List? ?? [])
                        Padding(
                          padding: const EdgeInsets.only(top: Grid.xs),
                          child: SelectableText(comment['content'] as String),
                        ),
                      TextButton(
                        onPressed: () => form(
                          'issues.comment',
                          '댓글 작성',
                          const [
                            FmgEditField(
                              'body',
                              '댓글',
                              multiline: true,
                              required: true,
                            ),
                          ],
                          {'issueId': issue['id']},
                        ),
                        child: const Text('댓글'),
                      ),
                    ],
                  ),
                ),
              ),
            if (data != null && (data['issues'] as List? ?? []).isEmpty)
              const Text('등록된 할 일이 없습니다.'),
          ],
          if (tab.value == 2) ...[
            FilledButton.icon(
              onPressed: () => form(
                'reviews.create',
                '검토 만들기',
                const [
                  FmgEditField('title', '제목', required: true),
                  FmgEditField('body', '내용', multiline: true),
                  FmgEditField('branch', '변경 브랜치', required: true),
                  FmgEditField('targetBranch', '기준 브랜치', required: true),
                  FmgEditField('commit', '변경 커밋', required: true),
                ],
                {},
                {'targetBranch': repository['defaultBranch']},
              ),
              icon: const Icon(Icons.add),
              label: const Text('검토 만들기'),
            ),
            for (final pr in data?['reviews'] as List? ?? [])
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(Grid.sm),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        pr['title'] as String,
                        style: context.textTheme.titleMedium,
                      ),
                      Text('${pr['status']} · 승인 ${pr['approvalCount']}개'),
                      if (pr['canReview'] == true)
                        TextButton(
                          onPressed: () => form(
                            'reviews.decide',
                            '코드 검토 결정',
                            const [
                              FmgEditField(
                                'decision',
                                '결정',
                                options: {
                                  'approve': '코드 변경 승인',
                                  'request-changes': '수정 요청',
                                },
                              ),
                              FmgEditField('body', '검토 의견', multiline: true),
                            ],
                            {
                              'reviewId': pr['id'],
                              'expectedCommit': pr['commit'],
                            },
                            {'decision': 'request-changes'},
                          ),
                          child: const Text('승인 / 수정 요청'),
                        ),
                      if (repository['owner'] == management.rpc.owner &&
                          pr['status'] == 'Open')
                        TextButton(
                          onPressed: () => form(
                            'reviews.merge',
                            '코드 병합 확인',
                            const [
                              FmgEditField(
                                'confirmation',
                                '현재 변경 커밋을 확인하고 입력',
                                required: true,
                                help: '병합하면 FMG 저장소의 기준 브랜치가 변경됩니다.',
                              ),
                            ],
                            {
                              'reviewId': pr['id'],
                              'expectedCommit': pr['commit'],
                            },
                          ),
                          child: const Text('병합'),
                        ),
                      SelectableText(
                        '${pr['branchName'] ?? ''} → ${pr['targetBranch'] ?? ''}\n${pr['content']}',
                      ),
                      if (pr['contentTruncated'] == true)
                        const Text('긴 내용은 일부만 표시됩니다. 전체 내용은 PC에서 확인하세요.'),
                      TextButton(
                        onPressed: () => form(
                          'reviews.comment',
                          '검토 댓글',
                          const [
                            FmgEditField(
                              'body',
                              '댓글',
                              multiline: true,
                              required: true,
                            ),
                          ],
                          {'reviewId': pr['id']},
                        ),
                        child: const Text('댓글'),
                      ),
                      if (pr['author'] == management.rpc.owner ||
                          repository['owner'] == management.rpc.owner)
                        TextButton(
                          onPressed: () => form(
                            'reviews.status',
                            '검토 상태 변경',
                            const [
                              FmgEditField(
                                'status',
                                '상태',
                                options: {
                                  'open': '열기',
                                  'draft': '초안',
                                  'closed': '닫기',
                                },
                              ),
                            ],
                            {
                              'reviewId': pr['id'],
                              'expectedCommit': pr['commit'],
                            },
                            {'status': 'open'},
                          ),
                          child: const Text('상태 변경'),
                        ),
                    ],
                  ),
                ),
              ),
            if (data != null && (data['reviews'] as List? ?? []).isEmpty)
              const Text('등록된 검토가 없습니다.'),
          ],
          if (tab.value != 0 && data != null)
            Wrap(
              spacing: Grid.sm,
              children: [
                Text('전체 ${data['total'] ?? 0}개 · ${offset.value + 1}부터 조회'),
                if (offset.value > 0)
                  TextButton(
                    onPressed: () => offset.value = 0,
                    child: const Text('처음으로'),
                  ),
                if (data['nextOffset'] is int)
                  TextButton(
                    onPressed: () => offset.value = data['nextOffset'] as int,
                    child: const Text('다음 목록'),
                  ),
              ],
            ),
          const SizedBox(height: 80),
        ],
      ),
    );
  }
}
