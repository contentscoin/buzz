import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../shared/fmg/fmg_updates.dart';
import '../../shared/theme/theme.dart';

/// An in-app update affordance, independent of community and pairing state.
class FmgUpdateCard extends ConsumerWidget {
  const FmgUpdateCard({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(fmgUpdatesProvider);
    final updater = ref.read(fmgUpdatesProvider.notifier);
    final busy = state.phase == 'checking' || state.phase == 'downloading';
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: Grid.gutter,
        vertical: Grid.xs,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.system_update),
              const SizedBox(width: Grid.xs),
              Expanded(
                child: Text(state.message, style: context.textTheme.bodyMedium),
              ),
              TextButton(
                onPressed: busy ? null : () => updater.check(force: true),
                child: const Text('다시 확인'),
              ),
            ],
          ),
          if (state.phase == 'downloading')
            LinearProgressIndicator(value: state.progress),
          if (state.phase == 'available' ||
              (state.phase == 'error' && state.release != null))
            FilledButton(
              onPressed: updater.download,
              child: const Text('업데이트 다운로드'),
            ),
          if (state.phase == 'ready')
            FilledButton(
              onPressed: updater.install,
              child: const Text('다운로드한 업데이트 설치'),
            ),
          SwitchListTile.adaptive(
            contentPadding: EdgeInsets.zero,
            title: const Text('자동 업데이트 확인'),
            subtitle: const Text(
              '6시간마다 확인 · Wi-Fi에서 자동 다운로드 · 설치 시 Android 확인',
            ),
            value: state.automatic,
            onChanged: busy
                ? null
                : (enabled) async {
                    try {
                      await updater.setAutomatic(enabled);
                    } catch (_) {
                      if (context.mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text('설정을 저장하지 못했습니다. 다시 시도해 주세요.'),
                          ),
                        );
                      }
                    }
                  },
          ),
        ],
      ),
    );
  }
}
