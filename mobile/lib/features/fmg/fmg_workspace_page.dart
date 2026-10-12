import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../shared/fmg/fmg_repository.dart';
import '../../shared/relay/relay.dart';
import '../../shared/theme/theme.dart';
import 'fmg_task_page.dart';
import 'fmg_document_page.dart';
import 'fmg_ui_labels.dart';

/// Adds task and result-document menus without altering channel navigation.
class FmgWorkspacePage extends HookConsumerWidget {
  const FmgWorkspacePage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repository = ref.watch(fmgRepositoryProvider);
    // Scope key destroys local list state when the active account changes.
    return repository == null
        ? const _FmgUnavailable()
        : _FmgWorkspace(
            key: ValueKey(repository.rpc.scope),
            repository: repository,
          );
  }
}

class _FmgUnavailable extends StatelessWidget {
  const _FmgUnavailable();
  @override
  Widget build(BuildContext context) => SafeArea(
    child: Padding(
      padding: const EdgeInsets.all(Grid.gutter),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('FMG 작업과 문서', style: context.textTheme.headlineSmall),
          const SizedBox(height: Grid.sm),
          const Text(
            '홈의 커뮤니티 선택에서 FMG로 전환하세요. 아직 연결하지 않았다면 기존 데스크톱 계정의 FMG 기기 페어링 QR을 스캔하세요.',
          ),
          const SizedBox(height: Grid.xs),
          const Text('BD 등 다른 커뮤니티의 작업을 FMG 작업으로 표시하지 않습니다.'),
        ],
      ),
    ),
  );
}

class _FmgWorkspace extends HookConsumerWidget {
  const _FmgWorkspace({super.key, required this.repository});
  final FmgRepository repository;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final connection = ref.watch(relaySessionProvider).status;
    final lifecycle = ref.watch(appLifecycleProvider);
    final tab = useState(0);
    final refresh = useState(0);
    final cursor = useState<String?>(null);
    final cursorHistory = useRef(<String?>[]);
    final future = useMemoized<Future<Object>>(
      () => tab.value == 0
          ? repository.tasks()
          : repository.documents(cursor.value),
      [
        repository,
        tab.value,
        refresh.value,
        cursor.value,
        connection,
        lifecycle,
      ],
    );
    final snapshot = useFuture(future);
    final loading = snapshot.connectionState != ConnectionState.done;
    final data = loading ? null : snapshot.data;
    void reload() {
      refresh.value++;
    }

    return SafeArea(
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              Grid.gutter,
              Grid.xs,
              Grid.xxs,
              Grid.xxs,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    'FMG 작업과 문서',
                    style: context.textTheme.headlineSmall,
                  ),
                ),
                IconButton(
                  tooltip: '새로 고침',
                  onPressed: loading ? null : reload,
                  icon: const Icon(Icons.refresh),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: Grid.gutter),
            child: SizedBox(
              width: double.infinity,
              child: SegmentedButton<int>(
                segments: const [
                  ButtonSegment(
                    value: 0,
                    icon: Icon(Icons.assignment_outlined),
                    label: Text('작업 목록'),
                  ),
                  ButtonSegment(
                    value: 1,
                    icon: Icon(Icons.description_outlined),
                    label: Text('결과 문서'),
                  ),
                ],
                selected: {tab.value},
                onSelectionChanged: (value) {
                  tab.value = value.single;
                  cursor.value = null;
                  cursorHistory.value.clear();
                },
              ),
            ),
          ),
          const SizedBox(height: Grid.xxs),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () async {
                reload();
              },
              child: loading
                  ? ListView(
                      children: const [
                        Padding(
                          padding: EdgeInsets.all(Grid.sm),
                          child: Center(child: CircularProgressIndicator()),
                        ),
                      ],
                    )
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(
                        Grid.gutter,
                        Grid.xxs,
                        Grid.gutter,
                        112,
                      ),
                      physics: const AlwaysScrollableScrollPhysics(),
                      children: [
                        if (snapshot.hasError) ...[
                          Text(
                            fmgDisplayError(snapshot.error),
                            style: TextStyle(color: context.colors.error),
                          ),
                          const SizedBox(height: Grid.xs),
                          FilledButton(
                            onPressed: reload,
                            child: const Text('다시 조회'),
                          ),
                        ],
                        if (data is FmgTaskSnapshot) ...[
                          if (data.cacheWarning)
                            const Text('목록을 조회했지만 오프라인 캐시를 저장하지 못했습니다.'),
                          Text(
                            data.cached
                                ? '오프라인 · ${fmgDate(data.fetchedAt)} 저장 목록입니다. 현재 실행 상태는 새로 조회해야 합니다.'
                                : '최근 작업 최대 25개 · ${fmgDate(data.fetchedAt)} 조회',
                            style: context.textTheme.bodySmall,
                          ),
                          const SizedBox(height: Grid.xxs),
                          if (data.tasks.isEmpty)
                            const Text('현재 소유자에게 조회 가능한 FMG 작업이 없습니다.'),
                          for (final task in data.tasks)
                            Card(
                              child: ListTile(
                                leading: Icon(
                                  task.status == 'succeeded'
                                      ? Icons.task_alt
                                      : Icons.assignment_outlined,
                                ),
                                title: Text(task.role),
                                subtitle: Text(
                                  '${task.label}\n${task.model} · effort ${task.effort}\n${task.id.substring(0, 8)}',
                                ),
                                isThreeLine: true,
                                trailing: const Icon(Icons.chevron_right),
                                onTap: () => Navigator.of(context).push(
                                  MaterialPageRoute<void>(
                                    builder: (_) => FmgTaskPage(
                                      taskId: task.id,
                                      expectedScope: repository.rpc.scope,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                        ],
                        if (data is FmgDocumentPage) ...[
                          const Text(
                            '원 제안 계정에서 접근을 허용한 비공개 결과 문서입니다. 문서 초안과 에이전트 원본은 구분해 표시합니다.',
                          ),
                          const SizedBox(height: Grid.xs),
                          if (data.documents.isEmpty)
                            const Text(
                              '접근이 허용된 저장 문서가 없습니다. 닷에서 작업별 문서 접근 허용을 확인하세요.',
                            ),
                          for (final doc in data.documents)
                            Card(
                              child: ListTile(
                                leading: const Icon(Icons.description_outlined),
                                title: Text('${doc.role} · 버전 ${doc.version}'),
                                subtitle: Text(
                                  '작업 ${doc.taskId.substring(0, 8)}\n${doc.raw['source_validation'] == 'verified_at_save' ? '저장 시 성공 종료 근거 확인' : '종료 근거 재확인 필요'}',
                                ),
                                trailing: const Icon(Icons.chevron_right),
                                onTap: () => Navigator.of(context).push(
                                  MaterialPageRoute<void>(
                                    builder: (_) => FmgDocumentPageView(
                                      document: doc,
                                      expectedScope: repository.rpc.scope,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              TextButton(
                                onPressed: cursorHistory.value.isEmpty
                                    ? null
                                    : () {
                                        cursor.value = cursorHistory.value
                                            .removeLast();
                                      },
                                child: const Text('이전 목록'),
                              ),
                              TextButton(
                                onPressed: data.cursor == null
                                    ? null
                                    : () {
                                        cursorHistory.value.add(cursor.value);
                                        cursor.value = data.cursor;
                                      },
                                child: const Text('다음 목록'),
                              ),
                            ],
                          ),
                        ],
                      ],
                    ),
            ),
          ),
        ],
      ),
    );
  }
}
