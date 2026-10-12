import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import '../../shared/fmg/fmg_management.dart';
import '../../shared/theme/theme.dart';
import 'fmg_control_status.dart';
import 'fmg_edit_form.dart';
import 'fmg_project_page.dart';
import 'fmg_ui_labels.dart';

/// Reads and creates the same NIP-MP projects visible in Desktop.
class FmgProjectsPage extends HookConsumerWidget {
  const FmgProjectsPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final management = ref.watch(fmgManagementProvider);

    final ready = useState(false);
    final refresh = useState(0);
    final future = useMemoized(
      () => management != null && ready.value
          ? management.read('projects.list')
          : null,
      [management, ready.value, refresh.value],
    );
    final snapshot = useFuture(future);
    final projects =
        (ready.value &&
                    snapshot.connectionState == ConnectionState.done &&
                    !snapshot.hasError
                ? ((snapshot.data?['projects'] as List?) ?? [])
                : [])
            .cast<Map<String, dynamic>>();
    Future<void> create() async {
      if (management == null) return;
      final result = await Navigator.push<Map<String, dynamic>>(
        context,
        MaterialPageRoute(
          builder: (_) => FmgEditForm(
            management: management,
            draftId: 'project:new',
            title: '프로젝트 만들기',
            fields: const [
              FmgEditField(
                'name',
                '프로젝트 이름',
                required: true,
                help: 'PC와 동일하게 이름에 영문이나 숫자가 필요합니다.',
              ),
              FmgEditField('description', '설명', multiline: true),
              FmgEditField(
                'visibility',
                '목록 공개',
                options: {'listed': '커뮤니티 목록에 표시', 'unlisted': '목록에 숨기기'},
              ),
              FmgEditField(
                'channelVisibility',
                '대화방 접근',
                options: {'open': '커뮤니티에 공개', 'private': '참여자만'},
              ),
            ],
            initial: const {
              'visibility': 'listed',
              'channelVisibility': 'open',
            },
            onSave: (values) => management.mutate('projects.create', values),
          ),
        ),
      );
      if (result != null && context.mounted) refresh.value++;
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('FMG 프로젝트'),
        actions: [
          IconButton(
            tooltip: '프로젝트 만들기',
            onPressed: management != null && ready.value ? create : null,
            icon: const Icon(Icons.add),
          ),
        ],
      ),
      body: management == null
          ? const Center(child: Text('FMG 커뮤니티로 전환하세요.'))
          : ListView(
              padding: const EdgeInsets.all(Grid.gutter),
              children: [
                FmgControlStatus(
                  management: management,
                  onDisconnected: () {
                    ready.value = false;
                  },
                  onConnected: () {
                    ready.value = true;
                    refresh.value++;
                  },
                ),
                if (!ready.value) const Text('PC 연결이 확인되면 프로젝트 목록을 불러옵니다.'),
                if (snapshot.connectionState == ConnectionState.waiting)
                  const LinearProgressIndicator(),
                if (snapshot.hasError)
                  Text(
                    fmgDisplayError(snapshot.error),
                    style: TextStyle(color: context.colors.error),
                  ),
                if (snapshot.data?['truncated'] == true)
                  const Text('목록 한도에 도달했습니다. PC에서 나머지 프로젝트를 확인하세요.'),
                if (ready.value &&
                    projects.isEmpty &&
                    snapshot.connectionState == ConnectionState.done &&
                    !snapshot.hasError)
                  const Text('프로젝트가 없습니다. + 버튼으로 만드세요.'),
                for (final project in projects)
                  Card(
                    child: ListTile(
                      leading: const Icon(Icons.folder_outlined),
                      title: Text(project['name'] as String),
                      subtitle: Text(
                        '${project['description'] ?? ''}\n저장소 ${(project['repositories'] as List).length}개',
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () async {
                        await Navigator.push<void>(
                          context,
                          MaterialPageRoute(
                            builder: (_) => FmgProjectPage(
                              management: management,
                              projectAddress:
                                  project['projectAddress'] as String,
                            ),
                          ),
                        );
                        if (context.mounted) refresh.value++;
                      },
                    ),
                  ),
                const SizedBox(height: 80),
              ],
            ),
    );
  }
}
