import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import '../../shared/fmg/fmg_management.dart';
import '../../shared/relay/relay.dart';
import '../../shared/theme/theme.dart';
import 'fmg_ui_labels.dart';

/// Exposes connection/recovery state and never treats a publish ACK as execution completion.
class FmgControlStatus extends HookConsumerWidget {
  const FmgControlStatus({
    super.key,
    required this.management,
    required this.onConnected,
    this.onDisconnected,
  });
  final FmgManagement management;
  final VoidCallback onConnected;
  final VoidCallback? onDisconnected;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final busy = useState(false);
    final message = useState<String?>(null);
    final generation = useRef(0);
    final session = ref.watch(relaySessionProvider).status;
    final lifecycle = ref.watch(appLifecycleProvider);
    Future<void> connect() async {
      if (!context.mounted || busy.value) return;
      final attempt = ++generation.value;
      busy.value = true;
      message.value = 'PC의 모바일 제어 응답을 확인하고 있습니다. 이전 연결을 다시 찾는 경우 최대 30초 걸립니다.';
      onDisconnected?.call();
      try {
        final result = await management.connect();
        if (context.mounted && generation.value == attempt) {
          message.value =
              'PC 연결됨 · ${(result['deviceId'] as String).substring(0, 8)}';
          onConnected();
        }
      } catch (error) {
        if (context.mounted && generation.value == attempt) {
          message.value =
              '${fmgDisplayError(error)}\nPC의 새 Buzz를 실행하고 FMG를 선택하세요.';
        }
      } finally {
        if (context.mounted && generation.value == attempt) busy.value = false;
      }
    }

    useEffect(() {
      var retired = false;
      // Run after build so parent readiness changes do not set state while building.
      Future.microtask(() {
        if (retired || !context.mounted) return;
        generation.value++;
        busy.value = false;
        if (lifecycle == AppLifecycleState.resumed &&
            session == SessionStatus.connected) {
          connect();
        } else {
          onDisconnected?.call();
          message.value = 'FMG 커뮤니티에 연결되면 PC 연결을 자동으로 확인합니다.';
        }
      });
      return () {
        retired = true;
        generation.value++;
      };
    }, [management, session, lifecycle]);

    Future<void> recover({bool resend = false}) async {
      if (busy.value) return;
      final attempt = ++generation.value;
      busy.value = true;
      try {
        final result = await management.recover(resendUnreceived: resend);
        if (!context.mounted || generation.value != attempt) return;
        message.value = switch (result['status']) {
          'none' => '확인 대기 중인 변경이 없습니다. PC 연결 상태는 연결 버튼으로 확인하세요.',
          'done' =>
            result['error'] == null
                ? '이전 변경의 종료 응답을 확인했습니다.'
                : '이전 변경이 실패했습니다. 설정을 다시 조회하세요.',
          'running' => '기존 요청이 처리 중이거나 종료 확인이 필요합니다. 다시 실행하지 않습니다.',
          'reviewed' => '이전 요청의 불확실한 기록을 보존하고 다음 편집을 허용했습니다.',
          'not_found' => 'PC에 기존 요청 기록이 없습니다. 같은 요청을 다시 전달할 수 있습니다.',
          _ => '완료 여부를 확인할 수 없습니다.',
        };
        if (result['status'] == 'running' &&
            result['requiresReview'] == true &&
            context.mounted) {
          final confirmed = await showDialog<bool>(
            context: context,
            builder: (context) => AlertDialog(
              title: const Text('기존 변경 확인'),
              content: const Text(
                '에이전트·프로젝트의 현재 설정을 직접 확인한 후 대기를 해제할 수 있습니다. 불확실한 실행 기록은 계속 보존됩니다.',
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: const Text('확인 더 하기'),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(context, true),
                  child: const Text('현재 설정 확인 · 대기 해제'),
                ),
              ],
            ),
          );
          if (confirmed == true && context.mounted) {
            await management.acknowledgeUncertain();
            if (context.mounted) message.value = '불확실한 기록을 보존하고 다음 편집을 허용했습니다.';
          }
        }
        if (result['status'] == 'not_found' && !resend && context.mounted) {
          final retry = await showDialog<bool>(
            context: context,
            builder: (context) => AlertDialog(
              title: const Text('기존 요청 다시 전달'),
              content: const Text(
                '기록되지 않은 원래 요청을 같은 요청 ID로 전달합니다. 다른 작업을 만들지 않습니다.',
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: const Text('닫기'),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(context, true),
                  child: const Text('다시 전달'),
                ),
              ],
            ),
          );
          if (retry == true && context.mounted) {
            busy.value = false;
            await recover(resend: true);
          }
        }
        // Local absence of a pending write is not evidence of a PC connection.
        if (context.mounted &&
            generation.value == attempt &&
            result['status'] != 'none') {
          final connected = await management.connect();
          if (context.mounted && generation.value == attempt) {
            message.value =
                '${message.value}\nPC 연결됨 · ${(connected['deviceId'] as String).substring(0, 8)}';
            onConnected();
          }
        }
      } catch (error) {
        if (context.mounted && generation.value == attempt) {
          message.value = fmgDisplayError(error);
          onDisconnected?.call();
        }
      } finally {
        if (context.mounted && generation.value == attempt) busy.value = false;
      }
    }

    return Padding(
      padding: const EdgeInsets.all(Grid.xs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'PC 실행기 제어 · PC의 Buzz가 켜져 있어야 합니다. Hostinger 작업·문서 조회는 기존 메뉴를 이용하세요.',
          ),
          Wrap(
            spacing: Grid.xs,
            children: [
              OutlinedButton.icon(
                onPressed: busy.value ? null : connect,
                icon: const Icon(Icons.computer),
                label: Text(busy.value ? '연결 확인 중…' : 'PC 연결 / 새로 고침'),
              ),
              TextButton(
                onPressed: busy.value ? null : recover,
                child: const Text('이전 요청 확인'),
              ),
            ],
          ),
          if (busy.value) const LinearProgressIndicator(),
          if (message.value != null)
            Text(message.value!, style: context.textTheme.bodySmall),
        ],
      ),
    );
  }
}
