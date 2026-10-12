import 'dart:async';
import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:uuid/uuid.dart';
import '../community/community_provider.dart';
import '../relay/relay.dart';
import 'fmg_rpc.dart';
import 'fmg_variant.dart';
import 'package:flutter/widgets.dart';

/// Explicit device controls; no arbitrary native command or shell invocation.
const fmgDesktopActions = {
  'desktop.discover',
  'operations.get',
  'operations.review',
  'agents.list',
  'agents.catalog',
  'agents.models',
  'agents.create',
  'agents.update',
  'agents.start',
  'agents.stop',
  'agents.restart',
  'agents.start_all',
  'agents.stop_all',
  'agents.attach',
  'agents.channels.list',
  'projects.list',
  'projects.get',
  'projects.create',
  'projects.update',
  'projects.attach',
  'projects.detach',
  'projects.add_repository',
  'projects.add_channel',
  'issues.list',
  'issues.create',
  'issues.comment',
  'issues.status',
  'issues.assign',
  'reviews.list',
  'reviews.comment',
  'reviews.status',
  'reviews.create',
  'reviews.decide',
  'reviews.merge',
  'repositories.snapshot',
  'repositories.file',
  'repositories.clone',
  'repositories.create_branch',
  'repositories.delete_branch',
};

/// Community transitions invalidate the control signer and pending UI completions.
final fmgManagementProvider = Provider.autoDispose<FmgManagement?>((ref) {
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
    desktop: true,
  );
  final unregister = ref.read(communityTransitionProvider).register(() async {
    rpc.close();
  });
  ref.onDispose(() {
    unregister();
    rpc.close();
  });
  return FmgManagement(rpc);
});

/// Owner-local encrypted drafts and one unresolved write prevent duplicate execution after an ACK loss.
class FmgManagement {
  FmgManagement(this.rpc);
  final FmgRpc rpc;
  static const _storage = FlutterSecureStorage();
  static Future<void> _tail = Future.value();
  String? deviceId;
  String get _key => 'fmg.mobile.management.v1:${rpc.scope}';

  Future<T> _serialized<T>(Future<T> Function() work) {
    final next = _tail.then((_) => work());
    _tail = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  Future<Map<String, dynamic>> _state() async {
    rpc.assertActive();
    final value = await _storage.read(key: _key);
    rpc.assertActive();
    if (value == null) return {'version': 1};
    if (value.length > 100000) {
      throw const FmgRequestException('journal_invalid');
    }
    final data = jsonDecode(value);
    if (data is! Map<String, dynamic> || data['version'] != 1) {
      throw const FmgRequestException('journal_invalid');
    }
    return data;
  }

  Future<void> _save(Map<String, dynamic> state) async {
    rpc.assertActive();
    final value = jsonEncode(state);
    if (value.length > 100000) throw const FmgRequestException('journal_full');
    await _storage.write(key: _key, value: value);
    rpc.assertActive();
  }

  /// Find the paired owner's Desktop; a durable device ID targets subsequent controls.
  Future<Map<String, dynamic>> connect() async {
    final saved = await _serialized(_state);
    final existing = saved['deviceId'];
    if (isFmgUuid(existing)) deviceId = existing as String;
    final discovered = await rpc.request('desktop.discover', {
      if (deviceId != null) 'deviceId': deviceId,
    });
    if (!isFmgUuid(discovered['deviceId'])) {
      throw const FmgRequestException('invalid_response');
    }
    final found = discovered['deviceId'] as String;
    if (deviceId != null && deviceId != found && saved['pending'] != null) {
      throw const FmgRequestException('device_changed');
    }
    deviceId = found;
    await _serialized(() async {
      final state = await _state();
      state['deviceId'] = found;
      await _save(state);
    });
    return discovered;
  }

  Future<void> _connected() async {
    if (deviceId == null) await connect();
    rpc.assertActive();
  }

  /// Reads exact PC inventories; no agent key/config is copied onto this device.
  Future<Map<String, dynamic>> read(
    String action, [
    Map<String, dynamic> input = const {},
  ]) async {
    await _connected();
    return rpc.request(action, {'deviceId': deviceId, 'input': input});
  }

  /// Persists an operation UUID before the first network send.
  Future<Map<String, dynamic>> mutate(
    String action,
    Map<String, dynamic> input,
  ) => _serialized(() async {
    await _connectedWithoutStorageLock();
    final state = await _state();
    if (state['pending'] != null) {
      throw const FmgRequestException('pending_operation');
    }
    final id = const Uuid().v4();
    final target = {
      'deviceId': deviceId,
      'input': input,
      'operationCreatedAt': DateTime.now().toUtc().toIso8601String(),
    };
    state['pending'] = {
      'requestId': id,
      'action': action,
      'target': target,
      'at': DateTime.now().toUtc().toIso8601String(),
    };
    await _save(state);
    // Any error preserves the pending entry: delivery alone is never a completed write.
    final result = await rpc.requestExisting(action, target, id);
    state.remove('pending');
    state['lastCompleted'] = id;
    await _save(state);
    return result;
  });
  Future<void> _connectedWithoutStorageLock() async {
    if (deviceId != null) return;
    final state = await _state();
    if (isFmgUuid(state['deviceId'])) {
      deviceId = state['deviceId'] as String;
      return;
    }
    throw const FmgRequestException('desktop_required');
  }

  /// Inspects the original UUID. Missing receipts may be retried using that exact UUID; running receipts stay uncertain.
  Future<Map<String, dynamic>> recover({bool resendUnreceived = false}) =>
      _serialized(() async {
        final state = await _state();
        final pending = state['pending'];
        if (pending is! Map<String, dynamic>) return {'status': 'none'};
        final target = pending['target'] as Map<String, dynamic>;
        final result = await rpc.request('operations.get', {
          'deviceId': target['deviceId'],
          'operationId': pending['requestId'],
        });
        if (result['status'] == 'done' || result['status'] == 'reviewed') {
          state.remove('pending');
          await _save(state);
          return result;
        }
        if (result['status'] == 'not_found' && resendUnreceived) {
          final retry = await rpc.requestExisting(
            pending['action'] as String,
            target,
            pending['requestId'] as String,
          );
          state.remove('pending');
          await _save(state);
          return {'status': 'done', 'result': retry};
        }
        return result;
      });

  /// A direct owner acknowledgement retains uncertainty and unlocks subsequent edits.
  Future<Map<String, dynamic>> acknowledgeUncertain() => _serialized(() async {
    final state = await _state();
    final pending = state['pending'];
    if (pending is! Map<String, dynamic>) return {'status': 'none'};
    final target = pending['target'] as Map<String, dynamic>;
    final result = await rpc.request('operations.review', {
      'deviceId': target['deviceId'],
      'operationId': pending['requestId'],
      'confirmation': pending['requestId'],
    });
    if (result['status'] == 'reviewed') {
      state.remove('pending');
      await _save(state);
    }
    return result;
  });

  /// Edit drafts survive restarts and are keyed by owner/community/entity.
  Future<void> saveDraft(String id, Map<String, dynamic>? value) =>
      _serialized(() async {
        final state = await _state();
        final drafts = Map<String, dynamic>.from(state['drafts'] as Map? ?? {});
        if (value == null) {
          drafts.remove(id);
        } else {
          drafts[id] = value;
        }
        if (drafts.length > 20) throw const FmgRequestException('draft_limit');
        state['drafts'] = drafts;
        await _save(state);
      });
  Future<Map<String, dynamic>?> draft(String id) => _serialized(() async {
    final value = (await _state())['drafts'];
    final draft = value is Map ? value[id] : null;
    return draft is Map ? Map<String, dynamic>.from(draft) : null;
  });
}
