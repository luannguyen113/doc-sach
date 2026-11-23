export const CONFIG = {
  version: '1.10.0',
  clientId: '878030336042-18q2nhn7ihp8i42galb3gljgtf45uib4.apps.googleusercontent.com',
  scopes: [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.appdata',
  ].join(' '),
  defaultRootFolder: 'Đọc sách',
  // Phiên đọc: không thao tác quá 2 phút thì dừng; phiên dưới 1 phút không tính.
  idleMs: 2 * 60 * 1000,
  minSessionSec: 60,
  // Sách "đang đọc" = mở trong 14 ngày gần nhất, tối đa 3 cuốn.
  recentDays: 14,
  maxReading: 3,
  remoteChunk: 1 << 20, // 1 MB mỗi lần đọc từng phần qua mạng
  localChunk: 1 << 20,
  // Tải offline: chia file thành khối 8 MB, tải 4 khối song song.
  dlSegment: 8 << 20,
  dlParallel: 4,
};
