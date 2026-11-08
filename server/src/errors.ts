// Thrown for anything the client did wrong; the code is what the app maps to a Chinese message.
export class HttpError extends Error {
  readonly status: 400 | 401 | 404 | 409 | 413 | 429
  readonly code: string
  constructor(status: HttpError['status'], code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}
