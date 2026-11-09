/**
 * The error classes supabase-js throws from `functions.invoke`.
 *
 * Ported code branches on them (`if (error instanceof FunctionsHttpError)`), so
 * they exist here and `invoke` puts the matching instance in `error`. It still
 * resolves rather than throws: the `{ data, error }` envelope is the contract
 * everywhere else in this SDK, and a method that sometimes throws and sometimes
 * does not is worse than either.
 */
export class FunctionsError extends Error {
    constructor(message: string, readonly name_ = 'FunctionsError', readonly context?: unknown) {
        super(message);
        this.name = name_;
    }
}

/** The function ran and answered with a non-2xx status. */
export class FunctionsHttpError extends FunctionsError {
    readonly status?: number;
    constructor(message: string, status?: number, context?: unknown) {
        super(message, 'FunctionsHttpError', context);
        this.status = status;
    }
}

/** The function threw before producing a response. */
export class FunctionsRelayError extends FunctionsError {
    constructor(message: string, context?: unknown) {
        super(message, 'FunctionsRelayError', context);
    }
}

/** The request never reached the function (network, abort, DNS). */
export class FunctionsFetchError extends FunctionsError {
    constructor(message: string, context?: unknown) {
        super(message, 'FunctionsFetchError', context);
    }
}
