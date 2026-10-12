import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../shared/fmg/fmg_repository.dart';
import '../../shared/relay/relay.dart';
import '../../shared/theme/theme.dart';
import 'fmg_ui_labels.dart';

/// Rechecks document access and hashes before rendering each immutable version.
class FmgDocumentPageView extends HookConsumerWidget {
  const FmgDocumentPageView({
    required this.document,
    required this.expectedScope,
    super.key,
  });
  final FmgDocument document;
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
    final version = useState(document.version);
    final refresh = useState(0);
    final showSource = useState(false);
    useEffect(() {
      if (!active) return null;
      final timer = Timer.periodic(const Duration(seconds: 90), (_) {
        showSource.value = false;
        refresh.value++;
      });
      return timer.cancel;
    }, [active]);
    final future = useMemoized(
      () => active ? repository.document(document, version.value) : null,
      [repository, active, version.value, refresh.value],
    );
    final snapshot = useFuture(future);
    final loading = snapshot.connectionState != ConnectionState.done;
    final item = active && !loading && !snapshot.hasError
        ? snapshot.data
        : null;
    final sourceFuture = useMemoized(
      () => active && item != null && showSource.value
          ? repository.source(item)
          : null,
      [repository, active, item, showSource.value],
    );
    final source = useFuture(sourceFuture);
    return Scaffold(
      appBar: AppBar(
        title: const Text('FMG 결과 문서'),
        actions: [
          IconButton(
            tooltip: '문서와 권한 새로 확인',
            onPressed: !active || loading
                ? null
                : () {
                    showSource.value = false;
                    refresh.value++;
                  },
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: !active
          ? Center(
              child: Text(
                sameScope
                    ? '연결 후 문서 접근을 다시 확인합니다.'
                    : '계정이나 커뮤니티가 변경됐습니다. 메뉴를 다시 여세요.',
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
          : item == null
          ? const SizedBox.shrink()
          : ListView(
              padding: const EdgeInsets.all(Grid.gutter),
              children: [
                Text('사용자 Markdown 초안', style: context.textTheme.titleLarge),
                const Text(
                  '성공한 작업의 종료 근거에 연결해 저장한 불변 문서입니다. 에이전트 출력 원본과는 다를 수 있습니다.',
                ),
                const SizedBox(height: Grid.xs),
                DropdownButtonFormField<int>(
                  initialValue: version.value,
                  key: ValueKey('${item.id}:${version.value}'),
                  decoration: const InputDecoration(labelText: '문서 버전'),
                  items: [
                    for (
                      var n = 1;
                      n <= (item.raw['current_version'] as int);
                      n++
                    )
                      DropdownMenuItem(value: n, child: Text('버전 $n')),
                  ],
                  onChanged: (value) {
                    if (value != null) {
                      showSource.value = false;
                      version.value = value;
                    }
                  },
                ),
                const SizedBox(height: Grid.xs),
                if (item.raw['source_validation'] == 'needs_reconcile')
                  Text(
                    '종료 근거 재확인 필요',
                    style: TextStyle(color: context.colors.error),
                  )
                else
                  const Text('저장 시 성공 종료 근거 확인 · 문서 SHA-256 검증 완료'),
                const SizedBox(height: Grid.xxs),
                ExpansionTile(
                  title: const Text('문서와 실행 근거'),
                  children: [
                    Padding(
                      padding: const EdgeInsets.all(Grid.xs),
                      child: SelectableText(
                        '문서: ${item.id}\n작업: ${item.taskId}\n실행: ${(item.raw['source'] as Map)['run_id']}\n'
                        '역할: ${item.role}\n요청 모델: ${(item.raw['source'] as Map)['requested_model']}\n'
                        'effort: ${(item.raw['source'] as Map)['requested_effort'] ?? '미기록'}\n'
                        '실제 모델: ${(item.raw['source'] as Map)['actual_model'] ?? '미기록'}\n'
                        '문서 SHA-256: ${item.hash}\n종료 receipt SHA-256: ${(item.raw['source'] as Map)['receipt_sha256']}',
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: Grid.xs),
                GptMarkdown(
                  item.markdown,
                  autolink: false,
                  // Private results never load remote images automatically.
                  imageBuilder: (_, _, _, _) =>
                      const Text('[외부 이미지 · 자동 로딩 안 함]'),
                  linkBuilder: (_, text, _, style) =>
                      Text.rich(text, style: style),
                ),
                const SizedBox(height: Grid.sm),
                OutlinedButton.icon(
                  onPressed: () => showSource.value = !showSource.value,
                  icon: const Icon(Icons.subject),
                  label: Text(showSource.value ? '원본 출력 닫기' : '에이전트 원본 출력 보기'),
                ),
                if (showSource.value) ...[
                  const SizedBox(height: Grid.xs),
                  const Text('에이전트 출력 원본 · 서버 보관 요약'),
                  if (source.connectionState != ConnectionState.done)
                    const LinearProgressIndicator()
                  else if (source.hasError)
                    Text(fmgDisplayError(source.error))
                  else
                    SelectableText(source.data ?? ''),
                ],
              ],
            ),
    );
  }
}
