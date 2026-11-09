export class BackendError extends Error {
    /** HTTP status code (0 if the request never completed). */
    readonly httpStatus: number;
    /** The API envelope's `status` field when present. */
    readonly apiStatus?: number;
    /** Backend error code, when present. */
    readonly code?: string;
    /**
     * Correlation id for the failed request, from the `x-request-id` response
     * header (the backend also puts it in the error body). Quote it in a bug
     * report or log it next to your own error: it is what matches this call to
     * the server-side stack trace in the project's logs.
     */
    readonly requestId?: string;

    constructor(message: string, httpStatus: number, apiStatus?: number, code?: string, requestId?: string) {
        super(message);
        this.name = 'BackendError';
        this.httpStatus = httpStatus;
        this.apiStatus = apiStatus;
        this.code = code;
        this.requestId = requestId;
    }
}