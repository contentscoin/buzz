import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:path_provider/path_provider.dart';

import '../theme/theme_provider.dart';
import 'fmg_variant.dart';

const _origin = 'https://buzz-dnb0.srv2006121.hstgr.cloud';
const _feed = '$_origin/fmg-updates/android/latest.json';
const _channel = MethodChannel('fmg/app_updates');
const _maxApk = 100 * 1024 * 1024;
const _interval = Duration(hours: 6);

/// Public release metadata; it never carries Buzz identity or credentials.
class FmgMobileRelease {
  FmgMobileRelease(Map<String, dynamic> json)
    : version = json['version'] as String,
      buildNumber = json['build_number'] as int,
      bytes = json['bytes'] as int,
      digest = json['sha256'] as String,
      url = Uri.parse(json['url'] as String) {
    if (json['schema'] != 1 ||
        json['application_id'] != 'xyz.fmg.buzz.mobile' ||
        json['architecture'] != 'arm64-v8a' ||
        !RegExp(r'^\d+\.\d+\.\d+$').hasMatch(version) ||
        buildNumber < 1 ||
        buildNumber > 2147483647 ||
        bytes < 1024 ||
        bytes > _maxApk ||
        !RegExp(r'^[0-9a-f]{64}$').hasMatch(digest) ||
        url.origin != _origin ||
        url.userInfo.isNotEmpty ||
        url.hasQuery ||
        url.hasFragment ||
        url.path != '/fmg-updates/artifacts/$digest.apk') {
      throw const FormatException('Invalid FMG update feed');
    }
  }
  final String version;
  final int buildNumber;
  final int bytes;
  final String digest;
  final Uri url;
  Map<String, Object> get nativeArguments => {
    'sha256': digest,
    'buildNumber': buildNumber,
  };
}

/// Visible update state distinguishes a prepared APK from an installed update.
class FmgUpdateState {
  const FmgUpdateState({
    this.phase = 'idle',
    this.message = '업데이트 자동 확인',
    this.release,
    this.progress = 0,
    this.automatic = true,
  });
  final String phase;
  final String message;
  final FmgMobileRelease? release;
  final double progress;
  final bool automatic;
}

final fmgUpdatesProvider = NotifierProvider<FmgUpdates, FmgUpdateState>(
  FmgUpdates.new,
);

/// Checks on app startup and foreground resumes, with a six-hour network bound.
class FmgUpdates extends Notifier<FmgUpdateState> {
  bool _disposed = false;
  bool _busy = false;
  HttpClient? _client;
  @override
  FmgUpdateState build() {
    final enabled =
        ref.read(savedPrefsProvider).getBool('fmg_auto_updates') ?? true;
    final timer = Timer.periodic(_interval, (_) => unawaited(check()));
    final observer = _UpdateLifecycle(() => unawaited(check()));
    WidgetsBinding.instance.addObserver(observer);
    ref.onDispose(() {
      _disposed = true;
      timer.cancel();
      _client?.close(force: true);
      WidgetsBinding.instance.removeObserver(observer);
    });
    unawaited(
      Future<void>.microtask(() async {
        await _restore();
        await check();
      }),
    );
    return FmgUpdateState(automatic: enabled);
  }

  void _set(
    String phase,
    String message, {
    FmgMobileRelease? release,
    double progress = 0,
  }) {
    if (!_disposed) {
      state = FmgUpdateState(
        phase: phase,
        message: message,
        release: release,
        progress: progress,
        automatic: state.automatic,
      );
    }
  }

  Future<void> setAutomatic(bool enabled) async {
    final saved = await ref
        .read(savedPrefsProvider)
        .setBool('fmg_auto_updates', enabled);
    if (!saved) throw StateError('업데이트 설정을 저장하지 못했습니다.');
    if (_disposed) return;
    state = FmgUpdateState(
      phase: state.phase,
      message: state.message,
      release: state.release,
      progress: state.progress,
      automatic: enabled,
    );
    if (enabled) await check(force: true);
  }

  Future<void> check({bool force = false}) async {
    if (_disposed ||
        _busy ||
        !isFmgMobile ||
        !Platform.isAndroid ||
        (!force && !state.automatic)) {
      return;
    }
    final prefs = ref.read(savedPrefsProvider);
    final last = prefs.getInt('fmg_update_last_attempt_ms');
    final now = DateTime.now().millisecondsSinceEpoch;
    if (!force &&
        last != null &&
        now >= last &&
        now - last < _interval.inMilliseconds) {
      return;
    }
    _busy = true;
    try {
      if (!await prefs.setInt('fmg_update_last_attempt_ms', now)) {
        throw const FileSystemException();
      }
      _set('checking', '새 버전 확인 중');
      final info = await PackageInfo.fromPlatform();
      if (info.packageName != 'xyz.fmg.buzz.mobile') {
        throw const FormatException();
      }
      final client = HttpClient()
        ..connectionTimeout = const Duration(seconds: 10);
      _client = client;
      final request = await client
          .getUrl(Uri.parse(_feed))
          .timeout(const Duration(seconds: 10));
      request.followRedirects = false;
      request.headers.set('Cache-Control', 'no-cache');
      final response = await request.close().timeout(
        const Duration(seconds: 10),
      );
      if (response.statusCode != 200) {
        throw const HttpException('Update unavailable');
      }
      final bytes = <int>[];
      await for (final part in response.timeout(const Duration(seconds: 10))) {
        if (bytes.length + part.length > 16384) throw const FormatException();
        bytes.addAll(part);
      }
      final release = FmgMobileRelease(
        jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>,
      );
      if (!await prefs.setInt('fmg_update_last_check_ms', now)) {
        throw const FileSystemException();
      }
      if (_disposed) return;
      if (release.buildNumber <= int.parse(info.buildNumber)) {
        await _cleanCache();
        _set('current', '최신 버전 ${info.version}');
      } else {
        if (!await prefs.setString(
          'fmg_update_release',
          jsonEncode({
            'schema': 1,
            'application_id': 'xyz.fmg.buzz.mobile',
            'architecture': 'arm64-v8a',
            'version': release.version,
            'build_number': release.buildNumber,
            'bytes': release.bytes,
            'sha256': release.digest,
            'url': release.url.toString(),
          }),
        )) {
          throw const FileSystemException();
        }
        _set('available', '새 버전 ${release.version}', release: release);
        final network = await Connectivity().checkConnectivity();
        if (!_disposed &&
            state.automatic &&
            network.contains(ConnectivityResult.wifi)) {
          await _download(release);
        }
      }
    } catch (_) {
      _set('error', '업데이트를 확인하지 못했습니다. 다시 확인을 눌러 주세요.');
    } finally {
      _client?.close(force: true);
      _client = null;
      _busy = false;
    }
  }

  Future<Directory> _directory() async {
    final base = await getTemporaryDirectory();
    final directory = Directory('${base.path}/fmg-updates');
    return directory.create(recursive: true);
  }

  Future<void> _restore() async {
    if (!isFmgMobile || !Platform.isAndroid || _disposed) return;
    final prefs = ref.read(savedPrefsProvider);
    final encoded = prefs.getString('fmg_update_release');
    if (encoded == null) return;
    try {
      if (encoded.length > 16384) throw const FormatException();
      final release = FmgMobileRelease(
        jsonDecode(encoded) as Map<String, dynamic>,
      );
      final info = await PackageInfo.fromPlatform();
      if (release.buildNumber <= int.parse(info.buildNumber)) {
        await _cleanCache();
        await prefs.remove('fmg_update_release');
        _set('current', '최신 버전 ${info.version}');
      } else {
        final directory = await _directory();
        if (await File('${directory.path}/${release.digest}.apk').exists()) {
          await _channel.invokeMethod<String>(
            'verify',
            release.nativeArguments,
          );
          _set('ready', '${release.version} 다운로드 완료', release: release);
        } else {
          _set('available', '새 버전 ${release.version}', release: release);
        }
      }
    } catch (_) {
      _set('error', '이전 업데이트 파일을 확인하지 못했습니다. 다시 확인해 주세요.');
    }
  }

  Future<void> _cleanCache({String? keep}) async {
    final directory = await _directory();
    var count = 0;
    await for (final file in directory.list(followLinks: false)) {
      if (++count > 20) throw const FileSystemException('Update cache limit');
      final name = file.uri.pathSegments.last;
      if (file is File &&
          name != keep &&
          RegExp(r'^[0-9a-f]{64}\.apk(?:\.part)?$').hasMatch(name)) {
        await file.delete();
      }
    }
  }

  Future<void> download() async {
    final release = state.release;
    if (_disposed || _busy || release == null) return;
    _busy = true;
    try {
      await _download(release);
    } catch (_) {
      _set('error', '다운로드 또는 파일 확인에 실패했습니다. 다시 다운로드해 주세요.', release: release);
    } finally {
      _client?.close(force: true);
      _client = null;
      _busy = false;
    }
  }

  Future<void> _download(FmgMobileRelease release) async {
    final directory = await _directory();
    final file = File('${directory.path}/${release.digest}.apk');
    if (await file.exists()) {
      try {
        await _channel.invokeMethod<String>('verify', release.nativeArguments);
        _set('ready', '${release.version} 다운로드 완료', release: release);
        return;
      } on PlatformException {
        await file.delete();
      }
    }
    await _cleanCache();
    final partial = File('${file.path}.part');
    _client?.close(force: true);
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 10);
    _client = client;
    IOSink? sink;
    try {
      _set('downloading', '${release.version} 다운로드 중', release: release);
      final request = await client
          .getUrl(release.url)
          .timeout(const Duration(seconds: 10));
      request.followRedirects = false;
      final response = await request.close().timeout(
        const Duration(seconds: 15),
      );
      if (response.statusCode != 200 ||
          (response.contentLength >= 0 &&
              response.contentLength != release.bytes)) {
        throw const HttpException('Invalid APK response');
      }
      sink = partial.openWrite();
      var count = 0;
      final deadline = DateTime.now().add(const Duration(minutes: 5));
      await for (final part in response.timeout(const Duration(seconds: 30))) {
        if (_disposed ||
            DateTime.now().isAfter(deadline) ||
            count + part.length > release.bytes) {
          throw const FileSystemException('Download stopped');
        }
        count += part.length;
        sink.add(part);
        await sink.flush();
        _set(
          'downloading',
          '${release.version} 다운로드 중',
          release: release,
          progress: count / release.bytes,
        );
      }
      await sink.close();
      sink = null;
      if (count != release.bytes ||
          (await sha256.bind(partial.openRead()).first).toString() !=
              release.digest) {
        throw const FormatException('APK checksum mismatch');
      }
      await partial.rename(file.path);
      await _channel.invokeMethod<String>('verify', release.nativeArguments);
      _set('ready', '${release.version} 다운로드 완료', release: release);
    } finally {
      await sink?.close();
      client.close(force: true);
      if (await partial.exists()) await partial.delete();
    }
  }

  Future<void> install() async {
    final release = state.release;
    if (_disposed || _busy || state.phase != 'ready' || release == null) return;
    _busy = true;
    try {
      final result = await _channel.invokeMethod<String>(
        'install',
        release.nativeArguments,
      );
      _set(
        'ready',
        result == 'permission_required'
            ? '이 앱의 설치 허용을 켠 뒤 돌아와 설치를 다시 누르세요.'
            : 'Android 설치 화면에서 업데이트를 확인하세요.',
        release: release,
      );
    } catch (_) {
      _set('error', '설치 화면을 열지 못했습니다. 다시 다운로드해 주세요.', release: release);
    } finally {
      _busy = false;
    }
  }
}

class _UpdateLifecycle extends WidgetsBindingObserver {
  _UpdateLifecycle(this.onResume);
  final void Function() onResume;
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) onResume();
  }
}

/// Keeps automatic checks active even when the user is viewing conversations.
class FmgUpdateBootstrap extends ConsumerWidget {
  const FmgUpdateBootstrap({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (isFmgMobile) ref.watch(fmgUpdatesProvider);
    return child;
  }
}
