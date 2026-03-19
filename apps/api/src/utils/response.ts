// ─── Consistent API response helpers ─────────────────────────────────────────
// All v1 dashboard API routes return:
//   Success → { success: true,  data: T }
//   Failure → { success: false, error: { code: string, message: string } }

export interface OkResponse<T> {
  success: true;
  data: T;
}

export interface ErrResponse {
  success: false;
  error: { code: string; message: string };
}

export function ok<T>(data: T): OkResponse<T> {
  return { success: true, data };
}

export function fail(code: string, message: string): ErrResponse {
  return { success: false, error: { code, message } };
}
