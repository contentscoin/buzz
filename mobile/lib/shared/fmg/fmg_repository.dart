import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:pointycastle/digests/sha256.dart';

import 'fmg_rpc.dart';

/// Binds read-only task/document access to the active FMG identity.
final fmgRepositoryProvider = Provider.autoDispose<FmgRepository?>((ref) {
  final rpc = ref.watch(fmgRpcProvider);
  return rpc == null ? null : FmgRepository(rpc);
});

String _fmgHash(List<int> bytes) => SHA256Digest()
    .process(Uint8List.fromList(bytes))
    .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
    .join();

Map<String, dynamic> _object(Object? raw) {
  if (raw is! Map<String, dynamic>) {
    throw const FmgRequestException('invalid_response');
  }
  return raw;
}

String _field(
  Map<String, dynamic> map,
  String name,
  int max, {
  bool nullable = false,
}) {
  final value = map[name];
  if (nullable && value == null) return '';
  if (value is! String || value.length > max) {
    throw const FmgRequestException('invalid_response');
  }
  return value;
}

void _uuid(Object? value) {
  if (!isFmgUuid(value)) throw const FmgRequestException('invalid_response');
}

void _sha(Object? value) {
  if (value is! String || !RegExp(r'^[0-9a-f]{64}$').hasMatch(value)) {
    throw const FmgRequestException('invalid_response');
  }
}

int _number(Object? value, int min, int max) {
  if (value is! int || value < min || value > max) {
    throw const FmgRequestException('invalid_response');
  }
  return value;
}

List<dynamic> _boundedList(Object? raw, int max) {
  if (raw is! List || raw.length > max) {
    throw const FmgRequestException('invalid_response');
  }
  return raw;
}

/// Ledger states retain the distinction between dispatch/cancel and completion.
const taskStatusLabels = {
  'awaiting_approval': '승인 대기',
  'approved': '실행 대기',
  'dispatching': '실행 요청됨',
  'cancel_requested': '취소 요청 · 종료 미확인',
  'needs_reconcile': '종료 기록 복구 필요',
  'succeeded': '완료',
  'failed': '실패',
  'canceled': '취소됨',
  'expired': '만료됨',
};

/// Validated task metadata; dispatch requests are never inferred as completion.
class FmgTask {
  FmgTask(this.raw, {bool detail = false}) {
    _uuid(raw['task_id']);
    _sha(raw['proposal_hash']);
    _number(raw['revision'], 1, 2147483647);
    if (!taskStatusLabels.containsKey(raw['status'])) {
      throw const FmgRequestException('invalid_response');
    }
    for (final key in ['created_at', 'updated_at']) {
      if (raw[key] is! num || !(raw[key] as num).isFinite) {
        throw const FmgRequestException('invalid_response');
      }
    }
    if (detail) {
      final proposal = _object(raw['proposal']);
      _field(proposal, 'role_id', 100);
      _field(proposal, 'requested_model', 200);
      _field(proposal, 'requested_effort', 20, nullable: true);
      _field(proposal, 'instructions', 30000);
      if (raw['run_id'] != null) _uuid(raw['run_id']);
      if (raw['result'] != null) {
        final result = _object(raw['result']);
        _field(result, 'reply', 30000, nullable: true);
        _field(result, 'actual_model', 200, nullable: true);
      }
    } else {
      _field(raw, 'role_id', 100);
      _field(raw, 'requested_model', 200);
      _field(raw, 'requested_effort', 20, nullable: true);
    }
  }
  final Map<String, dynamic> raw;
  String get id => raw['task_id'] as String;
  String get status => raw['status'] as String;
  String get label => taskStatusLabels[status]!;
  Map<String, dynamic> get proposal => raw['proposal'] is Map<String, dynamic>
      ? raw['proposal'] as Map<String, dynamic>
      : raw;
  String get role => proposal['role_id'] as String;
  String get model => proposal['requested_model'] as String;
  String get effort => proposal['requested_effort'] as String? ?? '미기록';
}

/// Immutable document metadata with bounded UTF-8 and SHA-256 validation.
class FmgDocument {
  FmgDocument(this.raw) {
    _uuid(raw['document_id']);
    _uuid(raw['request_id']);
    _sha(raw['content_sha256']);
    _number(raw['version'], 1, 20);
    _number(raw['current_version'], version, 20);
    if (_number(raw['previous_version'], 0, 19) != version - 1) {
      throw const FmgRequestException('invalid_response');
    }
    _number(raw['content_bytes'], 1, 32768);
    if (!{
      'verified_at_save',
      'needs_reconcile',
    }.contains(raw['source_validation'])) {
      throw const FmgRequestException('invalid_response');
    }
    final source = _object(raw['source']);
    _uuid(source['task_id']);
    _uuid(source['run_id']);
    for (final key in ['proposal_hash', 'response_sha256', 'receipt_sha256']) {
      _sha(source[key]);
    }
    _field(source, 'role_id', 100);
    _field(source, 'requested_model', 200);
    _field(source, 'requested_effort', 20, nullable: true);
    _field(source, 'actual_model', 200, nullable: true);
    if (source['source_completeness'] != 'stored_summary') {
      throw const FmgRequestException('invalid_response');
    }
    for (final value in [raw['saved_at'], source['verified_at']]) {
      if (value is! num || !value.isFinite) {
        throw const FmgRequestException('invalid_response');
      }
    }
  }
  final Map<String, dynamic> raw;
  String get id => raw['document_id'] as String;
  int get version => raw['version'] as int;
  String get taskId => (raw['source'] as Map)['task_id'] as String;
  String get role => (raw['source'] as Map)['role_id'] as String;
  String get hash => raw['content_sha256'] as String;
  String get markdown {
    final encoded = _field(raw, 'markdown_base64', 43692);
    final bytes = base64Decode(encoded);
    if (bytes.length != raw['content_bytes'] ||
        bytes.length > 32768 ||
        base64Encode(bytes) != encoded ||
        _fmgHash(bytes) != hash) {
      throw const FmgRequestException('integrity_error');
    }
    return utf8.decode(bytes, allowMalformed: false);
  }
}

/// Explicitly distinguishes current observations from an encrypted offline list.
class FmgTaskSnapshot {
  const FmgTaskSnapshot(
    this.tasks,
    this.fetchedAt, {
    this.cached = false,
    this.cacheWarning = false,
  });
  final List<FmgTask> tasks;
  final DateTime fetchedAt;
  final bool cached;
  final bool cacheWarning;
}

/// A bounded page of documents accessible to the original proposing account.
class FmgDocumentPage {
  const FmgDocumentPage(this.documents, this.cursor);
  final List<FmgDocument> documents;
  final String? cursor;
}

/// Uses the owner's existing broker without granting access or executing work.
class FmgRepository {
  FmgRepository(this.rpc);
  final FmgRpc rpc;
  static const _storage = FlutterSecureStorage();
  static const _cacheKey = 'fmg_tasks_snapshot_v1';
  static Future<void> _cacheTail = Future.value();
  int _readGeneration = 0;
  bool _cacheUnavailable = false;

  void _assertRead(int generation) {
    rpc.assertActive();
    if (generation != _readGeneration) {
      throw const FmgRequestException('stale_request');
    }
  }

  Future<void> _persistCache(String? value, int generation) {
    final operation = _cacheTail.then((_) async {
      _assertRead(generation);
      if (value != null) {
        await _storage.write(key: _cacheKey, value: value);
      } else {
        final existing = await _storage.read(key: _cacheKey);
        if (existing == null) return;
        if (_object(jsonDecode(existing))['scope'] == rpc.scope) {
          await _storage.delete(key: _cacheKey);
        }
      }
    });
    // The caller receives failures; only the serialization tail is recovered.
    _cacheTail = operation.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    return operation;
  }

  /// Reads up to 25 tasks; cached fallback is scoped, bounded and marked stale.
  Future<FmgTaskSnapshot> tasks() async {
    final generation = ++_readGeneration;
    try {
      final data = await rpc.request('tasks.list');
      if (data['limit'] != 25) {
        throw const FmgRequestException('invalid_response');
      }
      final tasks = _boundedList(
        data['tasks'],
        25,
      ).map((e) => FmgTask(_object(e))).toList();
      final now = DateTime.now().toUtc();
      final encoded = jsonEncode({
        'scope': rpc.scope,
        'at': now.toIso8601String(),
        'tasks': data['tasks'],
      });
      // One bounded encrypted snapshot; account/relay/Gateway must all match.
      if (utf8.encode(encoded).length <= 32768) {
        try {
          await _persistCache(encoded, generation);
          _cacheUnavailable = false;
        } on FmgRequestException {
          rethrow;
        } catch (_) {
          _cacheUnavailable = true;
        }
      } else {
        await _persistCache(null, generation);
        _cacheUnavailable = true;
      }
      _assertRead(generation);
      return FmgTaskSnapshot(tasks, now, cacheWarning: _cacheUnavailable);
    } on FmgRequestException catch (error) {
      if (error.code == 'scope_changed' || error.code == 'stale_request') {
        rethrow;
      }
      if (!{'offline', 'timeout'}.contains(error.code)) {
        _cacheUnavailable = true;
        try {
          await _persistCache(null, generation);
        } catch (_) {
          throw const FmgRequestException('cache_clear_failed');
        }
        rethrow;
      }
      if (_cacheUnavailable) rethrow;
      try {
        final encoded = await _storage.read(key: _cacheKey);
        if (encoded != null && encoded.length <= 32768) {
          final cache = _object(jsonDecode(encoded));
          final at = DateTime.parse(cache['at'] as String);
          final age = DateTime.now().difference(at);
          if (cache['scope'] == rpc.scope &&
              !age.isNegative &&
              age.inDays < 7) {
            _assertRead(generation);
            return FmgTaskSnapshot(
              _boundedList(
                cache['tasks'],
                25,
              ).map((e) => FmgTask(_object(e))).toList(),
              at,
              cached: true,
            );
          }
        }
      } catch (_) {
        /* Corrupt or unavailable caches are never authoritative. */
      }
      rethrow;
    }
  }

  /// Reads one task and rejects mismatched task identities.
  Future<FmgTask> task(String taskId) async {
    _uuid(taskId);
    final data = await rpc.request('tasks.get', {'taskId': taskId});
    final task = FmgTask(data, detail: true);
    if (task.id != taskId) throw const FmgRequestException('invalid_response');
    return task;
  }

  /// Lists only server-delegated documents; no offline permission fallback.
  Future<FmgDocumentPage> documents(String? cursor) async {
    if (cursor != null) _uuid(cursor);
    final data = await rpc.request('documents.list', {'cursor': cursor});
    final next = data['next_cursor'];
    if (data['limit'] != 20 || (cursor != null && next == cursor)) {
      throw const FmgRequestException('invalid_response');
    }
    if (next != null) _uuid(next);
    return FmgDocumentPage(
      _boundedList(
        data['documents'],
        20,
      ).map((e) => FmgDocument(_object(e))).toList(),
      next as String?,
    );
  }

  /// Lists at most 20 immutable versions for the selected task.
  Future<List<FmgDocument>> versions(String taskId) async {
    _uuid(taskId);
    final data = await rpc.request('documents.versions', {'taskId': taskId});
    final versions = _boundedList(
      data['versions'],
      20,
    ).map((e) => FmgDocument(_object(e))).toList();
    if (versions.any((e) => e.taskId != taskId)) {
      throw const FmgRequestException('invalid_response');
    }
    return versions;
  }

  /// Reads and verifies exact document bytes after checking live access.
  Future<FmgDocument> document(FmgDocument meta, int version) async {
    final data = await rpc.request('documents.get', {
      'taskId': meta.taskId,
      'documentId': meta.id,
      'version': version,
    });
    final item = FmgDocument(data);
    if (item.taskId != meta.taskId ||
        item.id != meta.id ||
        item.version != version) {
      throw const FmgRequestException('invalid_response');
    }
    item.markdown; // Validate bytes and SHA-256 before handing data to the UI.
    return item;
  }

  /// Reads the separately hashed, stored agent output for this document.
  Future<String> source(FmgDocument item) async {
    final data = await rpc.request('documents.source', {
      'taskId': item.taskId,
      'documentId': item.id,
      'version': item.version,
    });
    final meta = FmgDocument(data);
    if (meta.taskId != item.taskId ||
        meta.id != item.id ||
        meta.version != item.version ||
        (meta.raw['source'] as Map)['response_sha256'] !=
            (item.raw['source'] as Map)['response_sha256']) {
      throw const FmgRequestException('invalid_response');
    }
    final encoded = _field(data, 'source_base64', 56000);
    final bytes = base64Decode(encoded);
    if (bytes.length > 40000 ||
        base64Encode(bytes) != encoded ||
        _fmgHash(bytes) != (item.raw['source'] as Map)['response_sha256']) {
      throw const FmgRequestException('integrity_error');
    }
    return utf8.decode(bytes, allowMalformed: false);
  }
}
