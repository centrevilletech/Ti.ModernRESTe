// Type-checked by `npm run types`: the declarations have to accept the calls the README shows.
import Reste = require('../../reste');

interface Todo {
	id: number;
	title: string;
}

// With the methods named, each is typed and a misspelt one is an error.
const api = new Reste<{ getTodos: Todo[]; getTodo: Todo; createTodo: Todo }>();

// @ts-expect-error a method that was not declared
api.getTodoes();

// Without them every name is a method.
const loose = new Reste();
loose.config({ methods: [{ name: 'anything', get: 'x' }] });
loose.anything({ id: 1 }).then((value: unknown) => value);

api.config({
	url: 'https://api.example.com/v1/',
	timeout: 15000,
	requestHeaders: { Accept: 'application/json', Authorization: () => 'Bearer token' },
	unwrap: 'data',
	meta: 'meta',
	retry: { retries: 2, statuses: [502, 503], shouldRetry: (error, attempt, request) => (error.status === 409 && request.idempotencyKey ? true : undefined) },
	idempotency: { header: 'Idempotency-Key', methods: ['POST'] },
	cache: { store: Reste.fileStore('api-cache'), maxEntries: 50, scope: () => 'user-1' },
	authStatuses: [401, 419],
	progressStep: 0.05,
	identity: { limit: 500 },
	redact: { keys: ['iban'], url: url => url },
	dedupe: true,
	pagination: { style: 'page', perPage: 20 },
	mapError: (error) => new Error(error.message),
	onStatus: {
		401: () => Promise.resolve('retry' as const),
		426: (error) => {
			console.log(error.status);
		}
	},
	interceptors: {
		request: (request) => {
			request.headers['X-Trace'] = '1';
		},
		error: [(error) => (error instanceof Error ? undefined : { resolve: null })]
	},
	methods: [
		{ name: 'getTodos', get: 'todos', paginate: 'page', cache: 'etag' },
		{ name: 'getTodo', get: 'todos/<id>' },
		{ name: 'createTodo', post: 'todos', idempotent: true, invalidates: ['getTodos'] },
		{ name: 'upload', post: 'files', multipart: true },
		{ name: 'messages', get: 'messages', paginate: { style: 'cursor', limit: 30, order: 'asc' } }
	],
	models: [{
		name: 'todo',
		id: 'id',
		read: 'getTodo',
		create: 'createTodo',
		identity: true,
		collections: [{ name: 'todos', read: 'getTodos', content: 'data', merge: true, chunk: 100 }]
	}]
});

async function run(): Promise<void> {
	const todos: Todo[] = await api.getTodos({ query: { status: 'open', tags: ['a'] } });
	const handle = api.getTodo({ id: 1 }, { timeout: 5000, headers: { 'X-One': '1' } });
	const aborted: boolean = handle.abort();
	const key: string | null = handle.idempotencyKey;
	api.getTodo({ id: 1 }, (todo, response) => console.log(todo.title, response && response.status), (error, retry) => retry());

	const full = await api.request<Todo>('getTodo', { id: 2 }, { fullResponse: true }) as unknown as Reste.Response<Todo>;
	console.log(full.status, full.header('ETag'), full.data.title, full.notModified, todos.length, aborted, key);

	const controller = api.createAbortController();
	api.createTodo({ body: { title: 'x' } }, { signal: controller.signal, action: 'create-todo' }).catch((error: Reste.ResteError) => {
		if (error.isTimeout || error.kind === 'network') {
			console.log(error.retryAfter, error.body, error.headers['retry-after']);
		}
	});
	controller.abort();

	const pager = api.paginate<Todo>('getTodos', { perPage: 10, query: { status: 'open' } });
	const page = await pager.next();
	console.log(page.items[0].title, pager.hasMore, pager.total);

	const list = api.list({ collection: 'todos', filter: model => model.get('status') === 'open', place: 'end' });
	list.on('change', () => list.models());
	await list.load();
	const state: Reste.ListState = list.state;
	list.destroy();

	const own = { models: [] as unknown[] };
	const loaded = api.list({
		collection: own, paginate: { style: 'cursor', limit: 30 },
		load: (query, context) => Promise.resolve({ items: [{ id: query.before, aborted: context.signal.aborted }], meta: { has_more: false } })
	});
	loaded.loadOlder();
	const merged = api.upsert(own, [{ id: 1 }], { position: 'start' });
	const replaced: { id: number } = api.replace({ id: 1 }, { id: 1, title: 'x' });
	api.optimistic(own, { id: 'tmp' }, () => Promise.resolve({ id: 2 })).then(model => console.log(model, merged, replaced));
	api.config({ logger: (level, message, details: Reste.LogEvent) => console.log(level, message, details && details.event === 'response' ? details.elapsed : 0) });

	api.config({ methodOverride: { header: 'X-HTTP-Method-Override', methods: ['DELETE'], always: false }, methods: [{ name: 'closeAccount', delete: 'account', methodOverride: true }] });

	const needed: boolean = api.preload().inspect().loaded.data;
	console.log(needed);

	api.session.reset({ resetCollections: true });
	api.cache.invalidate('getTodo', { id: 1 });
	const remove = api.use({ response: response => response });
	remove();
	const counts: number = api.inspect().inFlight + api.identity.size('todo');
	api.createTodo({ body: {} }, { progressStep: 0, retry: false });
	console.log(counts);
	console.log(state, Reste.version, Reste.ResteError.is(new Error('x')), api.abortAll(request => request.name === 'getTodos'));
}

run();
