import '../../shared/fmg/fmg_rpc.dart';

String fmgDisplayError(Object? error) => error is FmgRequestException
    ? error.toString()
    : '조회할 수 없습니다. 연결을 확인하고 다시 조회하세요.';

String fmgDate(DateTime at) {
  final local = at.toLocal();
  String pad(int n) => n.toString().padLeft(2, '0');
  return '${local.month}/${local.day} ${pad(local.hour)}:${pad(local.minute)}';
}
