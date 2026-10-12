import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import '../../shared/fmg/fmg_management.dart';
import '../../shared/theme/theme.dart';
import 'fmg_control_status.dart';
import 'fmg_edit_form.dart';
import 'fmg_repository_page.dart';
import 'fmg_ui_labels.dart';

/// Project metadata, repository membership and project channels use current signed PC heads.
class FmgProjectPage extends HookConsumerWidget {
  const FmgProjectPage({
    super.key,
    required this.management,
    required this.projectAddress,
  });
  final FmgManagement management;
  final String projectAddress;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final currentManagement = ref.watch(fmgManagementProvider);
    final refresh = useState(0);
    final error = useState<String?>(null);
    final future = useMemoized(
      () => management.read('projects.get', {'projectAddress': projectAddress}),
      [management, projectAddress, refresh.value],
    );
    final snapshot = useFuture(future);
    final project = snapshot.data?['project'] as Map<String, dynamic>?;
    final owner = project?['owner'] == management.rpc.owner;
    final explicit = project?['legacy'] != true;
    Future<void> form(
      String action,
      String title,
      List<FmgEditField> fields, [
      Map<String, dynamic> initial = const {},
    ]) async {
      if (project == null) return;
      final revision = snapshot.data?['revision'];
      final result = await Navigator.push<Map<String, dynamic>>(
        context,
        MaterialPageRoute(
          builder: (_) => FmgEditForm(
            management: management,
            draftId: '$projectAddress:$action',
            title: title,
            fields: fields,
            initial: {...initial, '_baseRevision': revision},
            onSave: (values) => management.mutate(action, {
              'projectAddress': projectAddress,
              'expectedRevision': values.remove('_baseRevision') ?? revision,
              ...values,
            }),
          ),
        ),
      );
      if (context.mounted && result != null) refresh.value++;
    }

    Future<void> detach(Map<String, dynamic> repo) async {
      final result = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('프로젝트에서 저장소 분리'),
          content: Text('${repo['name']}를 이 프로젝트에서 분리합니다. 저장소와 대화 기록은 보존됩니다.'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('취소'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('분리'),
            ),
          ],
        ),
      );
      if (result != true || !context.mounted) return;
      try {
        await management.mutate('projects.detach', {
          'projectAddress': projectAddress,
          'expectedRevision': snapshot.data?['revision'],
          'repoAddress': repo['repoAddress'],
        });
        if (context.mounted) refresh.value++;
      } catch (reason) {
        if (context.mounted) error.value = fmgDisplayError(reason);
      }
    }

    if (currentManagement?.rpc.scope != management.rpc.scope) {
      return Scaffold(
        appBar: AppBar(title: const Text('프로젝트')),
        body: const Center(child: Text('계정이나 커뮤니티가 변경됐습니다. 다시 여세요.')),
      );
    }
    return Scaffold(
      appBar: AppBar(
        title: Text(project?['name'] as String? ?? '프로젝트'),
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
          if (snapshot.connectionState == ConnectionState.waiting)
            const LinearProgressIndicator(),
          if (snapshot.hasError || error.value != null)
            Text(
              error.value ?? fmgDisplayError(snapshot.error),
              style: TextStyle(color: context.colors.error),
            ),
          if (project != null) ...[
            Text(project['description'] as String? ?? ''),
            const SizedBox(height: Grid.sm),
            if (owner && explicit)
              Wrap(
                spacing: Grid.xs,
                children: [
                  OutlinedButton(
                    onPressed: () => form('projects.update', '프로젝트 수정', const [
                      FmgEditField('name', '이름', required: true),
                      FmgEditField('description', '설명', multiline: true),
                      FmgEditField(
                        'visibility',
                        '목록 공개',
                        options: {'listed': '표시', 'unlisted': '숨기기'},
                      ),
                    ], project),
                    child: const Text('프로젝트 수정'),
                  ),
                  OutlinedButton(
                    onPressed: () =>
                        form('projects.add_repository', '저장소 만들기', const [
                          FmgEditField('name', '저장소 이름', required: true),
                          FmgEditField('description', '설명', multiline: true),
                          FmgEditField(
                            'cloneUrl',
                            'FMG 저장소 주소',
                            help: '비워두면 FMG 릴레이 저장소를 사용합니다.',
                          ),
                        ]),
                    child: const Text('저장소 만들기'),
                  ),
                  OutlinedButton(
                    onPressed: () =>
                        form('projects.attach', '기존 저장소 연결', const [
                          FmgEditField(
                            'repoAddress',
                            '저장소 식별자',
                            required: true,
                            help: 'PC 저장소 정보의 30617:소유자공개키:이름 식별자를 입력하세요.',
                          ),
                        ]),
                    child: const Text('저장소 연결'),
                  ),
                  OutlinedButton(
                    onPressed: () => form(
                      'projects.add_channel',
                      '프로젝트 대화방 만들기',
                      const [
                        FmgEditField('name', '대화방 이름', required: true),
                        FmgEditField('description', '설명', multiline: true),
                        FmgEditField(
                          'channelVisibility',
                          '접근',
                          options: {'open': '공개', 'private': '참여자만'},
                        ),
                      ],
                      const {'channelVisibility': 'open'},
                    ),
                    child: const Text('대화방 만들기'),
                  ),
                ],
              ),
            const SizedBox(height: Grid.sm),
            Text('저장소', style: context.textTheme.titleMedium),
            for (final raw in project['repositories'] as List) ...[
              Card(
                child: ListTile(
                  title: Text(raw['name'] as String),
                  subtitle: Text(raw['description'] as String? ?? ''),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.push<void>(
                    context,
                    MaterialPageRoute(
                      builder: (_) => FmgRepositoryPage(
                        management: management,
                        projectAddress: projectAddress,
                        repository: Map<String, dynamic>.from(raw as Map),
                      ),
                    ),
                  ),
                ),
              ),
              if (owner && explicit)
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton(
                    onPressed: () =>
                        detach(Map<String, dynamic>.from(raw as Map)),
                    child: const Text('프로젝트에서 분리'),
                  ),
                ),
            ],
            const SizedBox(height: Grid.sm),
            Text('프로젝트 대화방', style: context.textTheme.titleMedium),
            if (project['channelId'] != null)
              SelectableText('홈 · ${project['channelId']}'),
            for (final id in project['relatedChannelIds'] as List? ?? [])
              SelectableText('연결된 대화방 · $id'),
            const Text('대화는 홈 → 대화방 목록에서 같은 방을 이용합니다.'),
            const SizedBox(height: Grid.sm),
            SelectableText(projectAddress, style: context.textTheme.bodySmall),
          ],
          const SizedBox(height: 80),
        ],
      ),
    );
  }
}
