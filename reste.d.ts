// Type definitions for RESTe 2.x
// Titanium's own types (Ti.Blob, Ti.Filesystem.File, the HTTP client, security managers) and Backbone's are
// not imported, so these declarations work with or without them: such values are typed structurally or `any`.

declare namespace Reste {
	type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
	type HeaderValue = string | number | null | undefined | (() => string | number | null | undefined);
	type Headers = Record<string, HeaderValue>;
	/** A path into a response body ('data', 'result.rows') or a function of it. */
	type Path<T = any> = string | ((body: any, context?: any) => T);

	/** What a failed request rejects with (unless `mapError` turns it into something else). */
	interface ResteError extends Error {
		name: 'ResteError';
		kind: 'http' | 'network' | 'timeout' | 'cancelled' | 'stale' | 'parse' | 'params' | 'config';
		/** HTTP status; 0 when there was no response. */
		status: number;
		/** The parsed response body (text when it is not JSON), or null. */
		body: any;
		/** Response headers, names lower-cased. */
		headers: Record<string, string>;
		url: string | null;
		method: string | null;
		/** The name of the method that was called. */
		endpoint: string | null;
		/** Retry-After in milliseconds, or null. */
		retryAfter: number | null;
		/** How many times the request was sent. */
		attempts: number;
		idempotencyKey: string | null;
		/** True when the device reported no connectivity. */
		offline: boolean;
		/** The HTTP client's error event, or what an interceptor threw. */
		cause: any;
		/** For `kind: 'params'`: the placeholders without a value. */
		missing?: string[];
		readonly isHttp: boolean;
		readonly isNetwork: boolean;
		readonly isTimeout: boolean;
		/** True for 'cancelled' and for 'stale'. */
		readonly isCancelled: boolean;
		readonly isStale: boolean;
		readonly isParse: boolean;
		readonly isOffline: boolean;
		// The names upstream's `errorsAsObjects` used.
		success: false;
		code: number;
		content: any;
		error: string;
		type: 'error';
		source?: any;
		toJSON(): Record<string, any>;
	}

	interface ResteErrorConstructor {
		new (kind: ResteError['kind'], message?: string, details?: Partial<ResteError>): ResteError;
		(kind: ResteError['kind'], message?: string, details?: Partial<ResteError>): ResteError;
		is(value: any): value is ResteError;
		readonly prototype: ResteError;
	}

	/** What a request resolves with when `fullResponse` is set. */
	interface Response<T = any> {
		ok: true;
		status: number;
		url: string;
		method: string;
		endpoint: string;
		/** The parsed body as the server sent it. */
		body: any;
		/** The body after `unwrap`. */
		data: T;
		/** The value at the `meta` path, or null. */
		meta: any;
		/** Downloads: the file written to, when one was given. */
		file: any;
		fromCache: boolean;
		/** Served from a stale cache entry (stale-while-revalidate, stale-if-error). */
		stale: boolean;
		/** The server answered 304 to a conditional request. */
		notModified: boolean;
		/** Collections only: the same bytes as the last refresh; the body was not parsed. */
		unchanged: boolean;
		attempts: number;
		/** Milliseconds from the call to the response. */
		duration: number;
		idempotencyKey: string | null;
		/** Response headers, names lower-cased. */
		readonly headers: Record<string, string>;
		readonly text: string | null;
		readonly etag: string | null;
		/** The Titanium HTTP client (null for a cache hit). */
		http: any;
		header(name: string): string | null;
	}

	/** The promise every call returns. */
	interface Handle<T = any> extends Promise<T> {
		/** Cancels the request: it rejects with `kind: 'cancelled'`. Returns false when it was already over (or never sent). */
		abort(reason?: any): boolean;
		cancel(reason?: any): boolean;
		/** The Idempotency-Key this call carries, or null. */
		idempotencyKey: string | null;
	}

	interface AbortSignal {
		aborted: boolean;
		reason?: any;
		addEventListener(type: 'abort', listener: (event: any) => void): void;
		removeEventListener(type: 'abort', listener: (event: any) => void): void;
	}

	interface AbortController {
		readonly signal: AbortSignal;
		readonly aborted: boolean;
		abort(reason?: any): void;
	}

	/** What interceptors, status hooks and `mapError` are told about a request. Interceptors may change it. */
	interface RequestInfo {
		name: string;
		method: string;
		url: string;
		headers: Record<string, any>;
		body: any;
		timeout: number;
		params: Record<string, any> | null;
		/** 1 for the first send. */
		attempt: number;
		idempotencyKey: string | null;
		/** `options.meta` of the call. */
		meta: any;
		/** True when a status hook already had this request sent again. */
		retried: boolean;
	}

	type RequestInterceptor = (request: RequestInfo) => void | Partial<RequestInfo> | Promise<void | Partial<RequestInfo>>;
	type ResponseInterceptor = (response: Response, request: RequestInfo) => void | Response | Promise<void | Response>;
	/** Return an Error to replace the error, `{ resolve: value }` to recover the request, nothing to pass it on. */
	type ErrorInterceptor = (error: ResteError | Error, request: RequestInfo) => void | Error | { resolve: any } | Promise<void | Error | { resolve: any }>;

	interface Interceptors {
		request?: RequestInterceptor | RequestInterceptor[];
		response?: ResponseInterceptor | ResponseInterceptor[];
		error?: ErrorInterceptor | ErrorInterceptor[];
	}

	interface RetryPolicy {
		/** Sends after the first one. Default 2. */
		retries?: number;
		/** Default 500 ms. */
		baseDelay?: number;
		/** Default 8000 ms. */
		maxDelay?: number;
		/** Default 2. */
		factor?: number;
		/** Share of the delay to vary by, 0 to 1. Default 0.25. */
		jitter?: number;
		/** Methods that may be repeated without an idempotency key. Default GET and HEAD. */
		methods?: string[];
		/** Statuses that are retried. Default 502, 503, 504. */
		statuses?: number[];
		/** Error kinds that are retried. Default network and timeout. */
		kinds?: Array<'network' | 'timeout' | 'parse'>;
		/** Wait at least as long as the server's Retry-After. Default true. */
		retryAfter?: boolean;
		/** Cap for Retry-After. Default 30000 ms. */
		maxRetryAfter?: number;
		/** Overrules the status and kind lists; return nothing to keep the default. Never asked for requests that are not safe to repeat. */
		shouldRetry?: (error: ResteError, attempt: number, request: { method: string; idempotencyKey: string | null; name: string }) => boolean | void;
	}

	interface CachePolicy {
		/** Milliseconds a response stays fresh, whatever the server says. Default: follow Cache-Control max-age. */
		ttl?: number | null;
		/** Honour Cache-Control. Default true. */
		respectHeaders?: boolean;
		/** Revalidate with If-None-Match / If-Modified-Since. Default true. */
		etag?: boolean;
		/** true, ms after expiry, false, or null to follow the server's stale-while-revalidate. */
		staleWhileRevalidate?: boolean | number | null;
		/** Answer from the stale copy when the network (or a 5xx) fails. */
		staleIfError?: boolean;
		/** Also keep the entry in the persistent store. */
		persist?: boolean;
		/** Request header names that are part of the cache key. */
		vary?: string[];
		key?: (request: RequestInfo) => string;
	}

	/** A persistent cache store: Reste.fileStore(), Reste.propertiesStore(), or your own. */
	interface CacheStore {
		getItem(key: string): string | null;
		setItem(key: string, value: string): void;
		removeItem(key: string): void;
		keys?(): string[];
	}

	interface PagePagination {
		style: 'page';
		pageParam?: string;
		perPageParam?: string;
		perPage?: number | null;
		firstPage?: number;
		items?: Path<any[]> | null;
		meta?: Path | null;
		page?: Path<number>;
		lastPage?: Path<number>;
		total?: Path<number>;
		hasMore?: Path<boolean> | null;
	}

	interface CursorPagination {
		style: 'cursor';
		limitParam?: string;
		limit?: number | null;
		/** Order of the list as held: 'asc' oldest first (default), 'desc' newest first. */
		order?: 'asc' | 'desc';
		/** next() sends the oldest item's cursor under this name. Default 'before'. */
		nextParam?: string;
		/** previous() sends the newest item's cursor under this name. Default 'after'. */
		previousParam?: string;
		cursorOf?: Path;
		/** Token cursors: the parameter that carries the server's cursor. */
		cursorParam?: string | null;
		nextCursor?: Path | null;
		previousCursor?: Path | null;
		items?: Path<any[]> | null;
		meta?: Path | null;
		hasMore?: Path<boolean>;
	}

	type Pagination = 'page' | 'cursor' | boolean | PagePagination | CursorPagination | Partial<PagePagination> | Partial<CursorPagination>;

	interface Page<T = any> {
		items: T[];
		meta: any;
		page: number | null;
		lastPage: number | null;
		total: number | null;
		hasMore: boolean;
		nextCursor: any;
		previousCursor: any;
		/** True when there is nothing further in this direction. */
		done: boolean;
		response?: Response;
		/** A refresh replaced the list while this page was loading. */
		discarded?: boolean;
	}

	interface Pager<T = any> {
		readonly style: 'page' | 'cursor';
		items: T[];
		meta: any;
		page: number;
		lastPage: number | null;
		total: number | null;
		hasMore: boolean;
		hasPrevious: boolean;
		loaded: boolean;
		loading: boolean;
		nextCursor: any;
		previousCursor: any;
		next(): Promise<Page<T>>;
		/** Cursor pagination: what is newer than the newest item held. */
		previous(): Promise<Page<T>>;
		refresh(): Promise<Page<T>>;
		abort(): void;
		reset(): void;
	}

	/** Options of a single call. */
	interface CallOptions {
		headers?: Headers;
		query?: Record<string, any>;
		/** Overrides params.body. */
		body?: any;
		timeout?: number;
		/** Total time allowed including retries; ends as `kind: 'timeout'`. */
		deadline?: number;
		signal?: AbortSignal;
		/**
		 * false, or a policy for this call. It changes how often and how patiently a request that is safe to
		 * repeat is sent again; it cannot make an unsafe one (a POST without an idempotency key) repeatable.
		 */
		retry?: boolean | number | RetryPolicy;
		idempotencyKey?: string;
		/** Names the user action: the same payload gets the same idempotency key until it succeeds. */
		action?: string;
		/** 'reload' skips the cached copy but refreshes it; 'no-store' bypasses the cache. */
		cache?: 'reload' | 'no-store' | false;
		/** Same as cache: 'reload'. */
		force?: boolean;
		dedupe?: boolean;
		fullResponse?: boolean;
		/** Upload progress for requests with a body, download progress otherwise: 0 to 1. */
		onProgress?: (fraction: number) => void;
		/** The smallest change in progress that is reported. Default 0.01; 0 reports every platform event. */
		progressStep?: number;
		onUploadProgress?: (fraction: number) => void;
		onDownloadProgress?: (fraction: number) => void;
		/** Downloads: the Ti.Filesystem.File (or path) to write to. */
		file?: any;
		/** Stale-while-revalidate: called when the background refresh brought new data. */
		onUpdate?: (data: any, response: Response) => void;
		interceptors?: Interceptors;
		/** Passed to interceptors, hooks and mapError as `request.meta`. */
		meta?: any;
	}

	/** Path values by placeholder name, plus `body` and `query`. */
	interface Params {
		body?: any;
		query?: Record<string, any> | string | number;
		[placeholder: string]: any;
	}

	type OnLoad<T = any> = (data: T, response?: Response<T>) => void;
	type OnError = (error: any, retry: () => Handle) => void;

	/** A method made from a definition: promise, callbacks, or both. */
	interface Method<T = any> {
		(params?: Params | null, options?: CallOptions): Handle<T>;
		(params: Params | null | undefined, onLoad: OnLoad<T>, onError?: OnError, options?: CallOptions): Handle<T>;
		(params: Params | null | undefined, onLoad: OnLoad<T>, options: CallOptions): Handle<T>;
		(onLoad: OnLoad<T>, onError?: OnError): Handle<T>;
	}

	interface MethodDefinition {
		name: string;
		get?: string | (() => string);
		post?: string | (() => string);
		put?: string | (() => string);
		patch?: string | (() => string);
		delete?: string | (() => string);
		head?: string | (() => string);
		/** Instead of a verb key: `{ method: 'OPTIONS', url: '...' }`. */
		method?: string;
		url?: string | (() => string);
		path?: string | (() => string);
		headers?: Headers;
		/** Upstream's name for `headers`. */
		requestHeaders?: Headers;
		/**
		 * Whether the instance's default headers are sent with this method. Default: yes for relative URLs and
		 * for full URLs on the base URL's origin, no for any other origin.
		 */
		globalHeaders?: boolean;
		/** Placeholders whose values are replaced in the debug log (those named like a credential are anyway). */
		redact?: string[];
		/** Query parameters sent with every call. */
		query?: Record<string, any>;
		timeout?: number;
		deadline?: number;
		/** Parameters that must be present in the params or the body. */
		expects?: string[];
		/** false: path values are sent as given. */
		encodeParams?: boolean;
		/** true (or a policy): repeating this request is harmless, whatever its HTTP method. false: never retry. */
		retry?: boolean | number | RetryPolicy;
		/** true: every call carries an Idempotency-Key (and may therefore be retried). */
		idempotent?: boolean;
		cache?: boolean | 'etag' | number | CachePolicy;
		/** Methods whose cached responses are dropped when this one succeeds. */
		invalidates?: string | string[];
		dedupe?: boolean;
		/** Send the body as multipart/form-data (automatic when it holds a Ti.Blob or file). */
		multipart?: boolean;
		upload?: boolean;
		/** Send the body form-encoded. */
		form?: boolean;
		/** Write the response to `options.file`, or resolve with the response blob. */
		download?: boolean;
		responseType?: 'json' | 'text' | 'blob';
		unwrap?: Path | false;
		meta?: Path | false;
		paginate?: Pagination;
		fullResponse?: boolean;
		/** false: the request survives a session reset (sign-in, public configuration). */
		session?: boolean;
		/** false: `onStatus` hooks do not fire for this method. */
		statusHooks?: boolean;
		interceptors?: Interceptors;
		mapError?: (error: ResteError | Error, request: RequestInfo) => any;
		onLoad?: (data: any, callback: (data: any) => void, response?: Response) => void;
		onError?: (error: any, callback: (data: any) => void, retry: () => Handle) => void;
		beforePost?: (body: any, callback: (body: any) => void) => void;
		beforeSend?: (body: any, callback: (body: any) => void) => void;
		clientOptions?: ClientOptions;
		securityManager?: any;
	}

	/** Creation properties passed to Ti.Network.createHTTPClient untouched. */
	interface ClientOptions {
		autoEncodeUrl?: boolean;
		autoRedirect?: boolean;
		cache?: boolean;
		domain?: string;
		enableKeepAlive?: boolean;
		username?: string;
		password?: string;
		tlsVersion?: number;
		withCredentials?: boolean;
	}

	interface IdentityOptions {
		/** Hold models weakly where the engine has WeakRef (default): a model lives as long as something holds it. */
		weak?: boolean;
		/** Without weak references: how many models to keep before dropping the oldest that no collection holds. Default 1000. */
		limit?: number;
	}

	interface CollectionDefinition {
		/** The name in Alloy.Collections. */
		name: string;
		/** The method that loads the list. */
		read?: string;
		/** Where the list is in the response. */
		content?: Path<any[]>;
		meta?: Path;
		paginate?: Pagination;
		perPage?: number;
		limit?: number;
		/** fetch() merges in place instead of resetting. */
		merge?: boolean;
		/** Merge this many items per turn of the event loop. */
		chunk?: number;
		/** 'each' keeps Backbone's per-model add / remove / change events during merges. Default 'coalesce'. */
		events?: 'coalesce' | 'each';
		/** The event fired once after a merge that changed something. Default 'fetch' (Alloy's binding listens to it). */
		changeEvent?: string;
		/** false: always parse and merge a refresh, even when the bytes are the same as last time. */
		skipUnchanged?: boolean;
		/** Path parameters sent with every load. */
		params?: Record<string, any>;
		query?: Record<string, any>;
	}

	interface ModelDefinition {
		name: string;
		/** The attribute that holds the id in the server's data. Default 'id'. */
		id?: string;
		/**
		 * As in 1.x (the default) a model's id is always its `id` attribute, and when `id` above names another
		 * attribute its value is copied into `id`. false: that attribute is the model's id and nothing is copied.
		 */
		mirrorId?: boolean;
		read?: string;
		create?: string;
		update?: string;
		patch?: string;
		delete?: string;
		/** Where the model is in a response. */
		content?: Path;
		transform?: (model: any) => any;
		beforeCreate?: (body: any, model: any) => any;
		beforeUpdate?: (body: any, model: any) => any;
		/** When given, its result is sent as the DELETE body; otherwise DELETE has none. */
		beforeDelete?: (body: any, model: any) => any;
		/** One model instance per id, shared by every collection of this model. */
		identity?: boolean | IdentityOptions;
		/** save(), destroy() and create() are optimistic by default. */
		optimistic?: boolean;
		/** Also keep one instance in Alloy.Models (true: under the model's name). */
		singleton?: boolean | string;
		collections?: CollectionDefinition[];
	}

	interface Config {
		/** The base URL. */
		url?: string;
		/** Default 10000 ms. */
		timeout?: number;
		deadline?: number;
		/** Headers sent with every request; a value may be a function. */
		requestHeaders?: Headers;
		methods?: MethodDefinition[];
		models?: ModelDefinition[];

		/** true: log requests; 'verbose': headers and bodies as well (credentials redacted). */
		debug?: boolean | 'verbose';
		logger?: (level: 'info' | 'warn' | 'error', message: string, details?: any) => void;
		/** More names to treat as credentials in the debug log, and a function applied to every logged URL. */
		redact?: { headers?: string[]; keys?: string[]; url?: (url: string, request: RequestInfo) => string };

		/** Default true since 2.0. false: callbacks receive the parsed error body only. */
		errorsAsObjects?: boolean;
		/** Upstream 1.x: an error without any error handler goes to the success callback. */
		errorsToOnLoad?: boolean;
		/** Kept for compatibility: missing path parameters are always reported since 2.0. */
		autoValidateParams?: boolean;
		/** false: path values are sent as given (upstream 1.x). */
		encodeParams?: boolean;
		query?: { arrayFormat?: 'brackets' | 'repeat' | 'indices' | 'comma'; nulls?: 'skip' | 'empty'; skipEmptyString?: boolean };
		querySerializer?: (query: Record<string, any>) => string;

		onLoad?: (data: any, callback: (data: any) => void, response?: Response) => void;
		onError?: OnError;
		beforePost?: (body: any, callback: (body: any) => void) => void;
		beforeSend?: (body: any, callback: (body: any) => void) => void;

		unwrap?: Path;
		meta?: Path;
		fullResponse?: boolean;
		mapError?: (error: ResteError | Error, request: RequestInfo) => any;
		/**
		 * Hooks by HTTP status, fired once per event. Answer 'retry' (or a promise of it) to have the requests
		 * sent again: those that are safe to repeat after any status, every request after one of `authStatuses`.
		 */
		onStatus?: Record<number, (error: ResteError, request: RequestInfo) => void | 'retry' | { retry: boolean } | Promise<void | 'retry' | { retry: boolean }>>;
		/** Statuses that mean "refused before anything was done": a hook's 'retry' re-sends any request. Default [401]. */
		authStatuses?: number[];
		interceptors?: Interceptors;

		retry?: boolean | number | RetryPolicy;
		idempotency?: { header?: string; methods?: string[]; generate?: () => string };
		cache?: {
			store?: CacheStore;
			maxEntries?: number;
			prefix?: string;
			defaults?: CachePolicy;
			/** Part of every cache key: the signed-in user's id, so one user never gets another's cached answer. */
			scope?: string | number | (() => string | number | null | undefined);
		};
		dedupe?: boolean;
		pagination?: Pagination;
		/** Reject at once, without sending, when Ti.Network.online is false. */
		failWhenOffline?: boolean;
		/** The smallest change in upload or download progress that is reported. Default 0.01. */
		progressStep?: number;

		/** Defaults for models and collections. */
		identity?: boolean | IdentityOptions;
		chunk?: number;
		events?: 'coalesce' | 'each';
		changeEvent?: string;

		securityManager?: any;
		/** Passed through only when set. Setting it to false disables certificate checks: never ship that. */
		validatesSecureCertificate?: boolean;
		clientOptions?: ClientOptions;

		/** Backbone, when it is not a global (Alloy makes it one). */
		Backbone?: any;
		/** A replacement for Ti.Network.createHTTPClient (tests). */
		httpClient?: (options: Record<string, any>) => any;
		/** Ignored since 2.0: promises are built in. */
		Q?: any;
	}

	interface MergeResult {
		/** The models of the response, in its order. */
		models: any[];
		added: any[];
		changed: any[];
		removed: any[];
		/** False when nothing was added, removed, changed or reordered. */
		touched: boolean;
		/** The refresh brought the same data as last time; nothing was parsed or merged. */
		unchanged?: boolean;
	}

	interface FetchOptions extends CallOptions {
		merge?: boolean;
		reset?: boolean;
		chunk?: number;
		events?: 'coalesce' | 'each';
		skipUnchanged?: boolean;
		params?: Record<string, any>;
		success?: (...args: any[]) => void;
		error?: (...args: any[]) => void;
		[placeholder: string]: any;
	}

	/** What RESTe adds to the Backbone collections it creates. */
	interface CollectionExtras {
		/** The metadata of the last response. */
		meta: any;
		paging: { style: 'page' | 'cursor'; page: number; lastPage: number | null; total: number | null; hasMore: boolean; hasPrevious: boolean; nextCursor: any } | null;
		fetch(options?: FetchOptions): Handle<any>;
		/** The first page again, merged in place. */
		refresh(options?: FetchOptions): Handle<MergeResult & Partial<Page>>;
		fetchNext(options?: FetchOptions): Handle<MergeResult & Partial<Page>>;
		fetchPrevious(options?: FetchOptions): Handle<MergeResult & Partial<Page>>;
		hasMore(): boolean;
		/** Merges items into the collection: existing models are updated, new ones added. */
		upsert(items: any | any[], options?: { position?: 'start' | 'end'; mode?: 'merge' | 'replace'; chunk?: number; events?: 'coalesce' | 'each' }): MergeResult | Promise<MergeResult>;
		/** Adds a model now, runs `send`, and gives the model the server's attributes or takes it out again. */
		optimistic(attributes: Record<string, any>, send: () => Promise<any>, options?: { at?: number }): Promise<any>;
	}

	/** What RESTe adds to the Backbone models it creates. */
	interface ModelExtras {
		/** When the server last sent this model (ms). */
		receivedAt?: number;
		transform(model?: any, transform?: (model: any) => any): any;
		/** Makes the model hold exactly these attributes. */
		replace(attributes: Record<string, any>): this;
		/** Changes attributes now, runs `send`, and puts them back when it fails. */
		optimistic(changes: Record<string, any>, send: () => Promise<any>): Promise<this>;
	}

	interface ListOptions {
		/** A collection from the models config, or its name. */
		collection: any;
		/** Default: the collection's read method. */
		method?: string;
		params?: Record<string, any> | (() => Record<string, any>);
		query?: Record<string, any> | (() => Record<string, any>);
		filter?: (model: any) => boolean;
		/** Where models joining from the collection go. Default 'start' ('end' for an oldest-first cursor list). */
		place?: 'start' | 'end';
		paginate?: Pagination;
		perPage?: number;
		limit?: number;
		content?: Path<any[]>;
		/** The models to show before the first answer. Default: the collection's models that pass `filter`. */
		cached?: () => any[];
		/** Destroys the list when it aborts. */
		signal?: AbortSignal;
		/** Decides when a 'change' is delivered. Default: on the next microtask. */
		schedule?: (deliver: () => void) => void;
		chunk?: number;
		request?: CallOptions;
	}

	type ListState = 'idle' | 'loading' | 'refreshing' | 'loadingMore' | 'error';

	/** A list that follows a collection. Also has Backbone.Events: on, off, trigger, listenTo. */
	interface List {
		readonly state: ListState;
		readonly error: any;
		readonly loaded: boolean;
		readonly failedMore: boolean;
		readonly total: number | null;
		readonly length: number;
		meta: any;
		on(event: 'change' | 'state' | 'error', callback: (...args: any[]) => void, context?: any): this;
		off(event?: string, callback?: (...args: any[]) => void, context?: any): this;
		load(): Promise<any>;
		refresh(): Promise<any>;
		loadMore(): Promise<any>;
		loadOlder(): Promise<any>;
		loadNewer(): Promise<any>;
		retry(): Promise<any>;
		reload(next?: { filter?: (model: any) => boolean; params?: any; query?: any }): Promise<any>;
		insert(model: any, options?: { at?: number }): void;
		remove(modelOrId: any): void;
		models(): any[];
		hasMore(): boolean;
		isEmpty(): boolean;
		destroy(): void;
	}

	interface Instance {
		config(config: Config): this;
		setUrl(url: string): void;
		getUrl(): string | undefined;
		clearCookies(url?: string): void;

		setRequestHeaders(headers?: Headers): void;
		changeRequestHeader(header: Headers): void;
		removeRequestHeaderItem(name: string): void;
		getRequestHeaders(): Headers;

		addMethod(definition: MethodDefinition): void;
		removeMethod(name: string): void;
		hasMethod(name: string): boolean;
		/** Calls a method by name, or sends a one-off request described inline. */
		request<T = any>(target: string | Omit<MethodDefinition, 'name'>, params?: Params | null, options?: CallOptions): Handle<T>;
		request<T = any>(target: string | Omit<MethodDefinition, 'name'>, params: Params | null | undefined, onLoad: OnLoad<T>, onError?: OnError, options?: CallOptions): Handle<T>;

		/** Adds interceptors; returns a function that removes them. */
		use(interceptors: Interceptors): () => void;

		session: {
			readonly generation: number;
			/** Ends the session: in-flight responses are dropped. */
			reset(options?: { abort?: boolean; clearCache?: boolean; resetCollections?: boolean }): number;
		};
		abortAll(filter?: (request: RequestInfo) => boolean): number;
		createAbortController(): AbortController;

		cache: {
			invalidate(matcher: string | RegExp | ((entry: any, key: string) => boolean), params?: Params): number;
			clear(): void;
			readonly size: number;
		};
		idempotency: {
			key(action: string, payload?: any): string;
			done(action: string): void;
			generate(): string;
			clear(): void;
		};

		paginate<T = any>(method: string, options?: { params?: Record<string, any>; query?: Record<string, any>; perPage?: number; limit?: number; paginate?: Pagination; idAttribute?: string; request?: CallOptions }): Pager<T>;
		list(options: ListOptions): List;

		addModel(definition: ModelDefinition): any;
		createModel(name: string, attributes?: Record<string, any>): any;
		createCollection(name: string, content: any[]): any;
		/** The one instance for an id of an `identity` model. */
		model(name: string, id: any): any;
		collections: Record<string, any>;
		models: Record<string, any>;
		identity: { get(name: string, id: any): any; clear(name?: string): void; size(name: string): number; sizes(): Record<string, number> };
		modelConfig?: Record<string, ModelDefinition>;
		/** Counts for finding leaks: requests in flight, cached responses, compiled URL variants, identity maps. */
		inspect(): { inFlight: number; shared: number; cache: number; variants: Record<string, number>; identity: Record<string, number> };
	}

	/**
	 * The methods made from the config. `new Reste<{ getTodos: Todo[]; getTodo: Todo }>()` types each of them
	 * and makes a misspelt name an error; without the type argument every name is a method resolving `any`.
	 */
	type Methods<M> = { [K in keyof M]: Method<M[K]> };
}

interface ResteStatic {
	new <M = Record<string, any>>(): Reste.Instance & Reste.Methods<M>;
	<M = Record<string, any>>(): Reste.Instance & Reste.Methods<M>;
	readonly version: string;
	ResteError: Reste.ResteErrorConstructor;
	createAbortController(): Reste.AbortController;
	/** A persistent cache store on Ti.App.Properties: for small responses. */
	propertiesStore(): Reste.CacheStore;
	/** A persistent cache store of one file per entry under the app's cache directory. */
	fileStore(directoryName?: string): Reste.CacheStore;
}

declare const Reste: ResteStatic;
export = Reste;
