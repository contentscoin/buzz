import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import '../../shared/fmg/fmg_management.dart';
import '../../shared/theme/theme.dart';
import 'fmg_control_status.dart';
import 'fmg_edit_form.dart';
import 'fmg_ui_labels.dart';

/// Edits the original PC agent record and controls exact public-key identities.
class FmgAgentsPage extends HookConsumerWidget {
  const FmgAgentsPage({super.key});
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final management = ref.watch(fmgManagementProvider);

    final refresh = useState(0);
    final ready = useState(false);
    final busy = useState(false);
    final error = useState<String?>(null);
    final future = useMemoized(
      () => management != null && ready.value
          ? management.read('agents.list')
          : null,
      [management, ready.value, refresh.value],
    );
    final snapshot = useFuture(future);
    final agents = (snapshot.data?['agents'] as List? ?? [])
        .cast<Map<String, dynamic>>();
    Future<void> action(
      String name, [
      Map<String, dynamic> input = const {},
    ]) async {
      if (management == null || busy.value) return;
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('에이전트 제어'),
          content: Text(
            name == 'agents.stop_all'
                ? 'FMG의 PC 로컬 에이전트를 모두 중지합니다. Hostinger의 OpenClaw는 계속 실행됩니다.'
                : name == 'agents.start_all'
                ? 'FMG의 중지된 PC 로컬 에이전트를 모두 시작합니다.'
                : '선택한 에이전트에 이 제어 요청을 적용할까요?',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('취소'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('적용'),
            ),
          ],
        ),
      );
      if (confirmed != true || !context.mounted) return;
      busy.value = true;
      error.value = null;
      try {
        final result = await management.mutate(name, input);
        if (context.mounted) {
          final failures = result['failures'] as List? ?? [];
          final results = result['results'] as List? ?? [];
          final failed =
              failures.length +
              results.where((r) => r is Map && r['status'] == 'failed').length;
          error.value = failed == 0
              ? null
              : '$failed개 에이전트 처리에 실패했습니다. 상태를 다시 조회하세요.';
          refresh.value++;
        }
      } catch (reason) {
        if (context.mounted) error.value = fmgDisplayError(reason);
      } finally {
        if (context.mounted) busy.value = false;
      }
    }

    Future<void> edit(Map<String, dynamic>? agent) async {
      if (management == null) return;
      busy.value = true;
      error.value = null;
      try {
        final data = await management.read(
          agent == null ? 'agents.catalog' : 'agents.models',
          agent == null ? {} : {'pubkey': agent['pubkey']},
        );
        if (!context.mounted) return;
        final current = agent == null
            ? <String, dynamic>{}
            : data['agent'] as Map<String, dynamic>;
        Map<String, String> optionList(
          String key, {
          bool availableOnly = false,
        }) => {
          for (final item in data[key] as List? ?? [])
            if (item is Map && (!availableOnly || item['available'] == true))
              item['id'] as String: (item['label'] ?? item['id']) as String,
        };
        final runtimeOptions = optionList('runtimes', availableOnly: true);
        final modelOptions = {'': '기본 모델 사용', ...optionList('models')};
        final providerOptions = optionList('providers');
        final effortOptions = {'': '실행기 기본값', ...optionList('effortOptions')};
        final fields = [
          const FmgEditField('name', '이름', required: true),
          if (current['systemPromptUnavailable'] != true)
            const FmgEditField('systemPrompt', '역할과 지시문', multiline: true),
          FmgEditField(
            'runtimeId',
            '실행기',
            resets: const ['provider', 'model', 'effort'],
            options: agent == null
                ? runtimeOptions
                : {'': '현재 실행기 유지', ...runtimeOptions},
            required: agent == null,
            help: '실행기를 변경하면 모델·제공자는 새 실행기의 기본값으로 초기화됩니다.',
          ),
          if (agent != null) ...[
            if (providerOptions.isNotEmpty)
              FmgEditField(
                'provider',
                '모델 제공자',
                options: providerOptions,
                resets: const ['model', 'effort'],
              ),
            FmgEditField(
              'model',
              '모델',
              resets: const ['effort'],
              options: modelOptions.containsKey(current['model'] ?? '')
                  ? modelOptions
                  : {
                      ...modelOptions,
                      current['model'] as String: '${current['model']} · 현재 설정',
                    },
              help: data['modelsUnavailable'] == true
                  ? '모델 목록을 조회하지 못했습니다. 현재 설정을 유지하거나 에이전트 실행 후 다시 여세요.'
                  : 'PC 실행기가 반환한 모델 목록입니다.',
            ),
            if (effortOptions.length > 1)
              FmgEditField('effort', '사고 강도 · effort', options: effortOptions),
            const FmgEditField(
              'parallelism',
              '동시 작업 수',
              numeric: true,
              required: true,
            ),
            FmgEditField(
              'respondTo',
              '응답 대상',
              options: data['ownerOnly'] == true
                  ? {'owner-only': '소유자만'}
                  : {
                      'owner-only': '소유자만',
                      'allowlist': '허용한 사용자',
                      'anyone': '누구나',
                    },
              help: '누구나를 선택하면 채널 참여자가 에이전트 도구에 요청할 수 있습니다.',
            ),
            const FmgEditField(
              'respondToAllowlist',
              '허용 사용자 공개키',
              multiline: true,
              help: '64자리 공개키를 줄마다 입력하세요. 허용한 사용자 모드에서 적용됩니다.',
            ),
            const FmgEditField(
              'autoRestartOnConfigChange',
              '설정 변경 시 자동 재시작',
              options: {'true': '켜기', 'false': '끄기'},
            ),
          ],
          const FmgEditField(
            'startOnAppLaunch',
            'PC Buzz 재시작 시 자동 시작',
            options: {'true': '켜기', 'false': '끄기'},
          ),
        ];
        final initial = {
          ...current,
          '_baseRevision': current['updatedAt'],
          'runtimeId': agent == null
              ? runtimeOptions.keys.firstOrNull ?? ''
              : '',
          'startOnAppLaunch': (current['startOnAppLaunch'] ?? false).toString(),
          'autoRestartOnConfigChange':
              (current['autoRestartOnConfigChange'] ?? true).toString(),
          'effort': data['effort'] ?? '',
          'respondTo': current['respondTo'] ?? 'owner-only',
          'respondToAllowlist': (current['respondToAllowlist'] as List? ?? [])
              .join('\n'),
        };
        final result = await Navigator.push<Map<String, dynamic>>(
          context,
          MaterialPageRoute(
            builder: (_) => FmgEditForm(
              management: management,
              draftId: 'agent:${agent?['pubkey'] ?? 'new'}',
              title: agent == null ? '에이전트 만들기' : '에이전트 수정',
              fields: fields,
              initial: initial,
              onSave: (values) async {
                final input = {
                  ...values,
                  'startOnAppLaunch': values['startOnAppLaunch'] == 'true',
                };
                if (agent != null) {
                  input['pubkey'] = current['pubkey'];
                  input['expectedUpdatedAt'] =
                      input.remove('_baseRevision') ?? current['updatedAt'];
                  input['autoRestartOnConfigChange'] =
                      values['autoRestartOnConfigChange'] == 'true';
                  input['respondToAllowlist'] =
                      (values['respondToAllowlist'] as String)
                          .split(RegExp(r'[\s,]+'))
                          .where((s) => s.isNotEmpty)
                          .toList();
                  if (input['runtimeId'] == '') input.remove('runtimeId');
                  if (input['provider'] == current['provider']) {
                    input.remove('provider');
                  }
                  if (input['model'] == current['model']) input.remove('model');
                  if (input['effort'] == (data['effort'] ?? '')) {
                    input.remove('effort');
                  }
                  if (input.containsKey('provider') &&
                      !input.containsKey('model')) {
                    input['model'] = '';
                  }
                }
                return management.mutate(
                  agent == null ? 'agents.create' : 'agents.update',
                  input,
                );
              },
            ),
          ),
        );
        if (context.mounted && result != null) {
          refresh.value++;
          error.value = result['profileSyncPending'] == true
              ? '설정은 저장됐지만 커뮤니티 프로필 반영이 대기 중입니다.'
              : null;
        }
      } catch (reason) {
        if (context.mounted) error.value = fmgDisplayError(reason);
      } finally {
        if (context.mounted) busy.value = false;
      }
    }

    Future<void> attach(Map<String, dynamic> agent) async {
      if (management == null) return;
      try {
        final data = await management.read('agents.channels.list');
        final channels = {
          for (final channel in data['channels'] as List? ?? [])
            channel['id'] as String: channel['name'] as String,
        };
        if (!context.mounted) return;
        await Navigator.push<Map<String, dynamic>>(
          context,
          MaterialPageRoute(
            builder: (_) => FmgEditForm(
              management: management,
              draftId: 'attach:${agent['pubkey']}',
              title: '에이전트 대화방 연결',
              fields: [
                FmgEditField(
                  'channelId',
                  '대화방',
                  options: channels,
                  required: true,
                ),
              ],
              initial: const {},
              onSave: (values) => management.mutate('agents.attach', {
                'pubkey': agent['pubkey'],
                ...values,
              }),
            ),
          ),
        );
      } catch (reason) {
        if (context.mounted) error.value = fmgDisplayError(reason);
      }
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('FMG 에이전트'),
        actions: [
          IconButton(
            tooltip: '에이전트 만들기',
            onPressed: management != null && ready.value && !busy.value
                ? () => edit(null)
                : null,
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
                  onConnected: () {
                    ready.value = true;
                    refresh.value++;
                  },
                ),
                Wrap(
                  spacing: Grid.xs,
                  children: [
                    FilledButton.icon(
                      onPressed: ready.value && !busy.value
                          ? () => action('agents.start_all')
                          : null,
                      icon: const Icon(Icons.play_arrow),
                      label: const Text('전체 시작'),
                    ),
                    OutlinedButton.icon(
                      onPressed: ready.value && !busy.value
                          ? () => action('agents.stop_all')
                          : null,
                      icon: const Icon(Icons.stop),
                      label: const Text('전체 중지'),
                    ),
                  ],
                ),
                const SizedBox(height: Grid.sm),
                if (busy.value ||
                    snapshot.connectionState == ConnectionState.waiting)
                  const LinearProgressIndicator(),
                if (error.value != null || snapshot.hasError)
                  Text(
                    error.value ?? fmgDisplayError(snapshot.error),
                    style: TextStyle(color: context.colors.error),
                  ),
                if (ready.value &&
                    agents.isEmpty &&
                    snapshot.connectionState == ConnectionState.done &&
                    !snapshot.hasError)
                  const Text('이 PC가 관리하는 FMG 에이전트가 없습니다.'),
                if (snapshot.data?['truncated'] == true)
                  const Text('목록 한도에 도달했습니다. PC에서 나머지 항목을 확인하세요.'),
                for (final agent in agents)
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(Grid.sm),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            agent['name'] as String,
                            style: context.textTheme.titleMedium,
                          ),
                          Text(
                            '${agent['model'] ?? '기본 모델'} · 실행 ${agent['execution'] ?? '미확인'}',
                          ),
                          Text(
                            '신원 ${(agent['pubkey'] as String).substring(0, 8)} · 설정 ${agent['status']}',
                            style: context.textTheme.bodySmall,
                          ),
                          if (agent['needsRestart'] == true)
                            const Text('새 설정 적용을 위해 재시작이 필요합니다.'),
                          Wrap(
                            children: [
                              TextButton(
                                onPressed: busy.value
                                    ? null
                                    : () => edit(agent),
                                child: const Text('수정'),
                              ),
                              TextButton(
                                onPressed: busy.value
                                    ? null
                                    : () => attach(agent),
                                child: const Text('대화방 연결'),
                              ),
                              TextButton(
                                onPressed:
                                    busy.value ||
                                        agent['backendType'] != 'local'
                                    ? null
                                    : () => action('agents.start', {
                                        'pubkey': agent['pubkey'],
                                      }),
                                child: const Text('시작'),
                              ),
                              TextButton(
                                onPressed:
                                    busy.value ||
                                        agent['backendType'] != 'local'
                                    ? null
                                    : () => action('agents.stop', {
                                        'pubkey': agent['pubkey'],
                                      }),
                                child: const Text('중지'),
                              ),
                              TextButton(
                                onPressed:
                                    busy.value ||
                                        agent['backendType'] != 'local'
                                    ? null
                                    : () => action('agents.restart', {
                                        'pubkey': agent['pubkey'],
                                      }),
                                child: const Text('재시작'),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                const SizedBox(height: 80),
              ],
            ),
    );
  }
}
