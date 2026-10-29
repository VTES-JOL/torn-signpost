/** An error with an HTTP status, returned to clients as `{ error, message }`. */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
