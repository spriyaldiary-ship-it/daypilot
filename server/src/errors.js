export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export class DuplicateError extends HttpError {
  constructor(type, duplicates) {
    super(409, `This looks similar to an existing ${type}.`, { code: 'duplicate', duplicates });
  }
}
