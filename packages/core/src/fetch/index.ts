import {
	BareCompatibleClient,
	BareResponse,
	ProxyTransport,
	BareRequestInit,
} from "@mercuryworkshop/proxy-transports";

import { type URLMeta } from "@rewriters/url";
import { type RamjetRequestMode } from "./parse";
import { RamjetHeaders } from "@/shared/headers";
import { HtmlRewriterHooks, RamjetContext } from "@/shared";
import { Tap, TapInstance } from "@/Tap";
import { doHandleFetch } from "./fetch";
import { _URL, _Map } from "@/shared/snapshot";
import { Prefetcher, type PrefetchOptions } from "./prefetch";
import { Preconnector, type PreconnectTarget } from "./preconnect";
export * from "./prefetch";

export interface RamjetFetchRequest {
	rawUrl: URL;
	rawReferrer: string | null;

	rawDestination: RequestDestination;
	mode: RequestMode;
	referrer: string;
	method: string;
	body: BodyType | null;
	cache: RequestCache;

	initialHeaders: RamjetHeaders;

	rawClientUrl?: URL;

	clientId?: string;

	prefetch?: boolean;
}

export interface RamjetFetchParsed {
	url: _URL;
	clientUrl?: _URL;
	referrerSourceUrl?: _URL | null;
	hadExtraParams: boolean;
	crossSiteRedirect: boolean;

	fetchSiteState?: "same-origin" | "same-site" | "cross-site";

	fetchInitiatorOrigin?: string;

	fetchCredentialsInclude?: boolean;

	fetchMode?: RamjetRequestMode;

	isIframe?: boolean;

	destination: RequestDestination;

	meta: URLMeta;
	isModule: boolean;
	isFakeDataURL: boolean;
	referrerPolicy?: string;
	trackedClient?: RamjetFetchTrackedClient;
}

export interface RamjetFetchResponse {
	body: BodyType;
	headers: RamjetHeaders;
	status: number;
	statusText: string;
}

export type CookieSyncEntry = {
	url: URL;
	cookie: string;
};

export type CookieSyncOptions = {
	clear?: boolean;
	destination?: RequestDestination;
};

export type FetchHandlerInit = {
	transport: ProxyTransport;
	context: RamjetContext;
	crossOriginIsolated?: boolean;

	streamHtml?: boolean;

	browserHeaders?: (url: URL) => [string, string][];

	prefetch?: Partial<PrefetchOptions> | false;

	sendSetCookie: (
		cookies: CookieSyncEntry[],
		options?: CookieSyncOptions,
	) => Promise<void>;
	fetchDataUrl(dataUrl: string): Promise<BareResponse>;
	fetchBlobUrl(blobUrl: string): Promise<BareResponse>;
};

export type TrackedHistoryState = {
	url: string;
	refererPolicy?: string;
};
export class RamjetFetchTrackedClient {
	history: TrackedHistoryState[] = [];
	constructor(public clientId: string) {}
}

// eslint-disable-next-line ramjet-core/no-globals
export class RamjetFetchHandler extends EventTarget {
	public client: BareCompatibleClient;
	public crossOriginIsolated: boolean = false;
	public context: RamjetContext;

	public trackedClients: Map<string, RamjetFetchTrackedClient> = new _Map<
		string,
		RamjetFetchTrackedClient
	>();
	public browserHeaders?: (url: URL) => [string, string][];
	public prefetcher: Prefetcher;
	public preconnector: Preconnector;
	public streamHtml: boolean;

	public hooks: {
		rewriter: {
			html: TapInstance<HtmlRewriterHooks>;
		};
		fetch: TapInstance<FetchHooks>;
	};

	public fetchDataUrl: (dataUrl: string) => Promise<Response>;
	public fetchBlobUrl: (blobUrl: string) => Promise<Response>;
	public sendSetCookie: (
		cookies: CookieSyncEntry[],
		options?: CookieSyncOptions,
	) => Promise<void>;

	constructor(init: FetchHandlerInit) {
		super();
		this.client = new BareCompatibleClient(init.transport);
		this.context = init.context;
		this.crossOriginIsolated = init.crossOriginIsolated || false;
		this.sendSetCookie = init.sendSetCookie;
		this.fetchDataUrl = init.fetchDataUrl;
		this.fetchBlobUrl = init.fetchBlobUrl;
		this.streamHtml = init.streamHtml !== false;
		this.browserHeaders = init.browserHeaders;
		this.prefetcher = new Prefetcher(
			this,
			init.prefetch === false ? { enabled: false } : init.prefetch,
		);
		this.preconnector = new Preconnector(
			() => this.client.transport as PreconnectTarget,
			() => this.context,
			this.prefetcher.options.preconnect,
		);
		this.hooks = {
			rewriter: {
				html: Tap.create<HtmlRewriterHooks>(),
			},
			fetch: Tap.create<FetchHooks>(),
		};
		this.context.hooks = {
			rewriter: this.hooks.rewriter,
		};
	}

	async handleFetch(request: RamjetFetchRequest): Promise<RamjetFetchResponse> {
		return doHandleFetch(this, request);
	}
}
export type FetchHooks = {
	intercept: {
		context: {
			request: RamjetFetchRequest;
			parsed: RamjetFetchParsed;
		};
		props: {
			response?: RamjetFetchResponse;
		};
	};
	request: {
		context: {
			request: RamjetFetchRequest;
			parsed: RamjetFetchParsed;
			client: BareCompatibleClient;
		};
		props: {
			init: BareRequestInit;
			url: URL;
			earlyResponse?: BareResponse;
		};
	};
	preresponse: {
		context: {
			request: RamjetFetchRequest;
			parsed: RamjetFetchParsed;
		};
		props: {
			response: BareResponse;
		};
	};
	response: {
		context: {
			request: RamjetFetchRequest;
			parsed: RamjetFetchParsed;
		};
		props: {
			response: RamjetFetchResponse;
		};
	};
};

export type BodyType = string | ArrayBuffer | Blob | ReadableStream<any>;
