import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../shared/fmg/fmg_repository.dart';
import '../../shared/relay/relay.dart';
import '../../shared/theme/theme.dart';
import 'fmg_document_page.dart';
import 'fmg_ui_labels.dart';

/// Shows a live-scoped task's instructions and separately recorded agent output.
class FmgTaskPage extends HookConsumerWidget {
  const FmgTaskPage({
    required this.taskId,
    required this.expectedScope,
    super.key,
  });
  final String taskId;
  final String expectedScope;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repository = ref.watch(fmgRepositoryProvider);
    final sameScope =
        repository != null && repository.rpc.scope == expectedScope;
    final connected =
        ref.watch(relaySessionProvider).status == SessionStatus.connected;
    final resumed =
        ref.watch(appLifecycleProvider) == AppLifecycleState.resumed;
    final active = sameScope && connected && resumed;
    final revision = useState(0);
    final future = useMemoized(() => active ? repository.task(taskId) : null, [
      repository,
      active,
      taskId,
      revision.value,
    ]);
    final snapshot = useFuture(future);
    final loading = snapshot.connectionState != ConnectionState.done;
    final task = active && !loading ? snapshot.data : null;
    return Scaffold(
      appBar: AppBar(
        title: const Text('FMG 작업 상세'),
        actions: [
          IconButton(
            tooltip: '작업 새로 고침',
            onPressed: !active || loading ? null : () => revision.value++,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: !active
          ? Center(
              child: Text(
                sameScope
                    ? '연결 후 작업 상태를 다시 조회합니다.'
                    : '계정이나 커뮤니티가 변경됐습니다. 메뉴를 닫고 다시 여세요.',
              ),
            )
          : loading
          ? const Center(child: CircularProgressIndicator())
          : snapshot.hasError
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(Grid.gutter),
                child: Text(fmgDisplayError(snapshot.error)),
              ),
            )
          : task == null
          ? const SizedBox.shrink()
          : ListView(
              padding: const EdgeInsets.all(Grid.gutter),
              children: [
                Text(task.role, style: context.textTheme.titleLarge),
                const SizedBox(height: Grid.xxs),
                Text('상태: ${task.label} · revision ${task.raw['revision']}'),
                Text('요청 모델: ${task.model}\neffort: ${task.effort}'),
                const SizedBox(height: Grid.xs),
                SelectableText(
                  '작업 ID: ${task.id}\n실행 ID: ${task.raw['run_id'] ?? '미기록'}',
                ),
                if (task.proposal['project'] is Map) ...[
                  const SizedBox(height: Grid.xs),
                  SelectableText(
                    '저장소: ${(task.proposal['project'] as Map)['repository_url']}\n브랜치: ${(task.proposal['project'] as Map)['branch']}',
                  ),
                ],
                const SizedBox(height: Grid.sm),
                Text('작업 지시문', style: context.textTheme.titleMedium),
                const SizedBox(height: Grid.xxs),
                SelectableText(task.proposal['instructions'] as String),
                const SizedBox(height: Grid.sm),
                Text('에이전트 출력 · 원본 결과', style: context.textTheme.titleMedium),
                const SizedBox(height: Grid.xxs),
                if (task.raw['result'] is Map) ...[
                  Text(
                    '실제 모델: ${(task.raw['result'] as Map)['actual_model'] ?? '기록 없음'}',
                  ),
                  SelectableText(
                    (task.raw['result'] as Map)['reply'] as String? ?? '출력 없음',
                  ),
                  if ((task.raw['result'] as Map)['reply_truncated'] == true)
                    const Text('서버가 보관한 요약 결과이며 출력 일부가 생략됐습니다.'),
                ] else
                  const Text('실행 결과가 아직 없습니다.'),
                const SizedBox(height: Grid.xs),
                if (task.status != 'succeeded')
                  const Text(
                    '출력이 있어도 성공 종료가 확인되지 않은 작업은 완료로 취급하지 않습니다. 취소 요청도 종료 확인을 뜻하지 않습니다.',
                  ),
                const SizedBox(height: Grid.sm),
                _TaskDocuments(
                  repository: repository,
                  taskId: task.id,
                  expectedScope: expectedScope,
                  revision: revision.value,
                ),
              ],
            ),
    );
  }
}

class _TaskDocuments extends HookWidget {
  const _TaskDocuments({
    required this.repository,
    required this.taskId,
    required this.expectedScope,
    required this.revision,
  });
  final FmgRepository repository;
  final String taskId;
  final String expectedScope;
  final int revision;
  @override
  Widget build(BuildContext context) {
    final opened = useState(false);
    final future = useMemoized(
      () => opened.value ? repository.versions(taskId) : null,
      [repository, taskId, revision, opened.value],
    );
    final snapshot = useFuture(future);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        OutlinedButton.icon(
          onPressed: () => opened.value = true,
          icon: const Icon(Icons.description_outlined),
          label: const Text('이 작업의 결과 문서'),
        ),
        if (opened.value && snapshot.connectionState != ConnectionState.done)
          const LinearProgressIndicator()
        else if (opened.value && snapshot.hasError)
          Text(fmgDisplayError(snapshot.error))
        else if (opened.value) ...[
          if (snapshot.data?.isEmpty ?? true) const Text('저장된 문서 버전이 없습니다.'),
          for (final doc in snapshot.data ?? <FmgDocument>[])
            ListTile(
              title: Text('사용자 Markdown 초안 · 버전 ${doc.version}'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => FmgDocumentPageView(
                    document: doc,
                    expectedScope: expectedScope,
                  ),
                ),
              ),
            ),
        ],
      ],
    );
  }
}
