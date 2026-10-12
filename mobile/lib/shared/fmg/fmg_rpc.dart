import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/widgets.dart';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:uuid/uuid.dart';

import '../community/community_provider.dart';
import '../crypto/nip44.dart';
import '../relay/relay.dart';
import 'fmg_variant.dart';
import 'fmg_management.dart' show fmgDesktopActions;

/// Retires encrypted requests before switching identities or communities.
final fmgRpcProvider = Provider.autoDispose<FmgRpc?>((ref) {
  final config = ref.watch(relayConfigProvider);
  final uri = Uri.tryParse(config.baseUrl);
  if (!isFmgMobile ||
      uri == null ||
      uri.origin != fmgRelayOrigin ||
      (uri.path.isNotEmpty && uri.path != '/') ||
      uri.hasQuery ||
      uri.hasFragment ||
      uri.userInfo.isNotEmpty ||
      config.nsec == null) {
    return null;
  }
  final rpc = FmgRpc(
    config.nsec!,
    ref.read(relaySessionProvider.notifier),
    () =>
        ref.read(relaySessionProvider).status == SessionStatus.connected &&
        ref.read(appLifecycleProvider) == AppLifecycleState.resumed,
  );
  final unregister = ref.read(communityTransitionProvider).register(() async {
    rpc.close();
  });
  ref.onDispose(() {
    unregister();
    rpc.close();
  });
  return rpc;
});

/// Bounded broker failure codes mapped to Korean messages without raw secrets.
class FmgRequestException implements Exception {
  const FmgRequestException(this.code);
  final String code;
  @override
  String toString() => switch (code) {
    'offline' => '서버에 연결되지 않았습니다. 연결 후 새로 고침하세요.',
    'timeout' => '서버 응답 시간이 초과됐습니다. 다시 조회하세요.',
    'desktop_timeout' =>
      'PC의 모바일 제어 응답이 없습니다. PC에서 같은 계정의 FMG를 선택하고 업데이트를 적용했는지 확인하세요.',
    'device_changed' => '이전 PC 연결이 변경됐습니다. 기존 요청 확인을 마친 뒤 새 PC를 연결하세요.',
    'publish_failed' => '릴레이가 요청을 수락하지 않았습니다. 커뮤니티 연결을 확인하세요.',
    'publish_timeout' => '릴레이의 요청 수신을 확인하지 못했습니다. 변경 요청은 이전 요청 확인으로 조회하세요.',
    'scope_changed' => '계정이나 커뮤니티가 변경됐습니다. FMG 메뉴를 다시 여세요.',
    'owner_mismatch' => 'FMG 소유자 계정이 아닙니다. 기존 데스크톱 소유자 계정으로 기기를 페어링하세요.',
    'cache_clear_failed' => '접근을 확인할 수 없고 목록 캐시 제거에도 실패했습니다. 연결 후 다시 조회하세요.',
    'stale_request' => '새 조회가 시작됐습니다. 최신 조회를 기다리세요.',
    'desktop_access_required' ||
    'document_unavailable' => '원 제안 계정에서 이 작업의 문서 접근을 허용해야 합니다.',
    'access_denied' || 'task_read_failed' => '소유권 또는 작업 접근을 확인할 수 없습니다.',
    'rate_limited' => '조회가 많습니다. 잠시 후 다시 조회하세요.',
    'tasks_unavailable' => '서버의 작업 조회 연결이 준비되지 않았습니다.',
    'integrity_error' || 'invalid_response' => '서버 응답 검증에 실패했습니다.',
    'desktop_required' => 'PC의 Buzz를 켜고 FMG 커뮤니티를 선택한 뒤 다시 연결하세요.',
    'pending_operation' => '확인이 끝나지 않은 변경이 있습니다. 이전 요청 확인을 눌러 중복 실행을 방지하세요.',
    'needs_reconcile' => 'PC가 변경 도중 종료되어 완료 여부가 불명확합니다. 원래 요청을 확인하세요.',
    'revision_conflict' => 'PC 또는 다른 기기에서 설정을 변경했습니다. 다시 조회한 뒤 수정하세요.',
    'runtime_unavailable' => '선택한 실행기가 PC에 설치되거나 로그인되어 있지 않습니다.',
    'effort_unavailable' =>
      '이 실행기의 effort 선택지가 아직 확인되지 않았습니다. 에이전트 실행 후 다시 조회하세요.',
    'owner_only_required' => '현재 PC 설정에서는 소유자의 요청에만 응답할 수 있습니다.',
    'remote_lifecycle_unavailable' =>
      '이 에이전트는 다른 실행 서버의 관리를 받습니다. 해당 서버에서 제어해야 합니다.',
    'community_repository_required' => '현재 커뮤니티에 연결된 저장소만 제어할 수 있습니다.',
    'operation_failed' => 'PC에서 처리를 완료하지 못했습니다. 이전 요청 확인과 PC 설정을 확인하세요.',
    'journal_full' ||
    'journal_unavailable' ||
    'journal_invalid' => '변경 기록을 안전하게 보관할 수 없습니다. 저장 공간과 이전 요청을 확인하세요.',
    'response_too_large' => '조회 내용이 너무 큽니다. 항목별 상세 화면에서 확인하세요.',
    'confirmation_required' => '검토 화면에 표시된 현재 변경 커밋을 정확히 입력해 주세요.',
    'parallelism_invalid' => '동시 작업 수가 실행기의 허용 범위를 벗어났습니다.',
    'request_expired' => '기존 요청의 보관 기간이 지났습니다. 현재 상태를 확인한 뒤 새로 작업하세요.',
    _ => '서버 요청이 거부됐습니다. 연결 상태와 접근 권한을 확인하세요.',
  };
}

/// Gateway reads retain the existing NIP-44 broker. Explicit Desktop mode uses
/// encrypted NIP-78 owner app data for bounded device management actions.
/// No operator token, OAuth token or pairing password is forwarded.
class FmgRpc {
  FmgRpc(String nsec, this._session, this._connected, {this.desktop = false})
    : _privateKey = nostr.Nip19.decode(payload: nsec).data,
      owner = pubkeyFromNsec(nsec)! {
    _conversation = getConversationKey(_privateKey, peer);
  }
  final bool desktop;
  String get peer => desktop ? owner : fmgGatewayPubkey;
  String _privateKey;
  final String owner;
  final RelaySessionNotifier _session;
  final bool Function() _connected;
  late final Uint8List _conversation;
  bool _closed = false;
  final _pending = <Completer<Map<String, dynamic>>>{};
  final _cleanups = <void Function()>{};
  String get scope => '$fmgRelayOrigin|$owner|$peer';

  /// Rejects storage/UI work left over from a retired account generation.
  void assertActive() {
    if (_closed) throw const FmgRequestException('scope_changed');
  }

  static const _actions = {
    'tasks.list',
    'tasks.get',
    'documents.list',
    'documents.get',
    'documents.versions',
    'documents.source',
  };
  static const _targets = <String, Set<String>>{
    'tasks.list': {},
    'tasks.get': {'taskId'},
    'documents.list': {'cursor'},
    'documents.versions': {'taskId'},
    'documents.get': {'taskId', 'documentId', 'version'},
    'documents.source': {'taskId', 'documentId', 'version'},
  };

  /// Cancels outstanding queries, subscriptions and transient key material.
  void close() {
    if (_closed) return;
    _closed = true;
    for (final done in _pending.toList()) {
      if (!done.isCompleted) {
        done.completeError(const FmgRequestException('scope_changed'));
      }
    }
    for (final cleanup in _cleanups.toList()) {
      cleanup();
    }
    _cleanups.clear();
    _conversation.fillRange(0, _conversation.length, 0);
    _privateKey = '';
  }

  /// Queries a read-only action with a unique, signed and encrypted request UUID.
  Future<Map<String, dynamic>> request(
    String action, [
    Map<String, dynamic> target = const {},
  ]) => _request(action, target, const Uuid().v4());

  /// Reuses a persisted operation UUID after response loss; never creates another write.
  Future<Map<String, dynamic>> requestExisting(
    String action,
    Map<String, dynamic> target,
    String requestId,
  ) {
    if (!isFmgUuid(requestId)) throw ArgumentError('Invalid operation UUID');
    return _request(action, target, requestId);
  }

  Future<Map<String, dynamic>> _request(
    String action,
    Map<String, dynamic> target,
    String id,
  ) async {
    if (_closed) throw const FmgRequestException('scope_changed');
    if (owner != fmgOwnerPubkey) {
      throw const FmgRequestException('owner_mismatch');
    }
    if (!_connected()) throw const FmgRequestException('offline');
    if (!(desktop ? fmgDesktopActions : _actions).contains(action)) {
      throw ArgumentError('Read-only action required');
    }
    final allowed = desktop
        ? (action == 'desktop.discover'
              ? {'deviceId'}
              : action == 'operations.get'
              ? {'deviceId', 'operationId'}
              : action == 'operations.review'
              ? {'deviceId', 'operationId', 'confirmation'}
              : {'deviceId', 'input', 'operationCreatedAt'})
        : _targets[action]!;
    if (target.keys.any((key) => !allowed.contains(key))) {
      throw ArgumentError('Read-only target fields required');
    }
    if (_pending.length >= 3) throw const FmgRequestException('rate_limited');
    final done = Completer<Map<String, dynamic>>();
    // Register an error listener before subscription/publish can yield.
    unawaited(done.future.catchError((Object _) => <String, dynamic>{}));
    _pending.add(done);
    void Function()? unsubscribe;
    final discovery = desktop && action == 'desktop.discover';
    final timer = Timer(Duration(seconds: discovery ? 15 : 60), () {
      if (!done.isCompleted) {
        done.completeError(
          FmgRequestException(desktop ? 'desktop_timeout' : 'timeout'),
        );
      }
    });
    final started = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    try {
      unsubscribe = await _session.subscribe(
        NostrFilter(
          kinds: [desktop ? 30078 : 24200],
          authors: [peer],
          since: started - 1,
          limit: 10,
          tags: {
            if (desktop) '#t': ['fmg-mobile-control'],
            '#p': [owner],
            '#frame': ['telemetry'],
          },
        ),
        (event) {
          if (_closed ||
              done.isCompleted ||
              event.pubkey != peer ||
              event.kind != (desktop ? 30078 : 24200) ||
              event.content.length > 100000 ||
              event.createdAt < started - 1 ||
              (event.createdAt - DateTime.now().millisecondsSinceEpoch ~/ 1000)
                      .abs() >
                  90) {
            return;
          }
          bool tag(String key, String value) {
            final tags = event.tags
                .where((t) => t.isNotEmpty && t.first == key)
                .toList();
            return tags.length == 1 &&
                tags.single.length >= 2 &&
                tags.single[1] == value;
          }

          if (!tag('p', owner) ||
              (desktop && !tag('t', 'fmg-mobile-control')) ||
              (desktop && !tag('d', 'fmg.mobile:$id:result')) ||
              !tag('agent', peer) ||
              !tag('frame', 'telemetry')) {
            return;
          }
          try {
            // The relay session does not verify incoming signatures itself.
            nostr.Event.fromMap(event.toJson(), verify: true);
            final frame = jsonDecode(
              nip44Decrypt(_conversation, event.content),
            );
            if (frame is! Map ||
                frame['kind'] !=
                    (desktop
                        ? 'fmg_mobile_desktop_result'
                        : 'fmg_computer_result')) {
              return;
            }
            final payload = frame['payload'];
            if (payload is! Map ||
                payload['requestId'] != id ||
                payload['action'] != action ||
                payload['relay'] != fmgRelayOrigin ||
                (desktop &&
                    target['deviceId'] != null &&
                    payload['generation'] != target['deviceId'])) {
              return;
            }
            if (payload['schemaVersion'] != 1 ||
                payload['ok'] is! bool ||
                !isFmgUuid(payload['generation']) ||
                payload['checkedAt'] is! String ||
                DateTime.tryParse(payload['checkedAt']) == null) {
              throw const FmgRequestException('invalid_response');
            }
            if (DateTime.now()
                    .difference(DateTime.parse(payload['checkedAt']))
                    .inSeconds
                    .abs() >
                90) {
              throw const FmgRequestException('invalid_response');
            }
            if (payload['ok'] != true) {
              final code = payload['error'];
              done.completeError(
                FmgRequestException(
                  code is String && RegExp(r'^[a-z_]{1,64}$').hasMatch(code)
                      ? code
                      : 'invalid_response',
                ),
              );
            } else if (payload['result'] is Map<String, dynamic>) {
              done.complete(payload['result'] as Map<String, dynamic>);
            } else {
              done.completeError(const FmgRequestException('invalid_response'));
            }
          } catch (error) {
            // Invalid signatures/unrelated ciphertext are ignored, not accepted.
            if (error is FmgRequestException && !done.isCompleted) {
              done.completeError(error);
            }
          }
        },
        onClosed: (_) {
          if (!done.isCompleted) {
            done.completeError(const FmgRequestException('offline'));
          }
        },
      );
      if (_closed) throw const FmgRequestException('scope_changed');
      _cleanups.add(unsubscribe);
      final content = nip44Encrypt(
        _conversation,
        jsonEncode({
          'type': desktop
              ? 'fmg.mobile.desktop.request'
              : 'fmg.computer.request',
          'schemaVersion': 1,
          'requestId': id,
          'relay': fmgRelayOrigin,
          'expiresAt': DateTime.now()
              .toUtc()
              .add(Duration(seconds: discovery ? 14 : 55))
              .toIso8601String(),
          'action': action,
          ...target,
        }),
      );
      final signed = nostr.Event.from(
        kind: desktop ? 30078 : 24200,
        content: content,
        tags: [
          if (desktop) ['d', 'fmg.mobile:$id:request'],
          if (desktop) ['t', 'fmg-mobile-control'],
          ['p', peer],
          ['agent', peer],
          ['frame', 'control'],
        ],
        secretKey: _privateKey,
        verify: false,
      );
      final send = _session
          .publish(NostrEvent.fromJson(signed.toMap()))
          .catchError((Object error) {
            if (error is TimeoutException) {
              throw const FmgRequestException('publish_timeout');
            }
            throw const FmgRequestException('publish_failed');
          });
      final results = await Future.wait([done.future, send], eagerError: true);
      if (_closed) throw const FmgRequestException('scope_changed');
      return results.first as Map<String, dynamic>;
    } finally {
      timer.cancel();
      _pending.remove(done);
      if (!done.isCompleted) {
        done.completeError(const FmgRequestException('scope_changed'));
      }
      if (unsubscribe != null) {
        _cleanups.remove(unsubscribe);
        unsubscribe();
      }
    }
  }
}

/// Accepts only full lowercase UUIDs used by the server's immutable ledger.
bool isFmgUuid(Object? value) =>
    value is String &&
    RegExp(
      r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    ).hasMatch(value);
