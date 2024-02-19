import {
	AppBskyEmbedExternal,
	AppBskyEmbedImages,
	AppBskyEmbedRecord,
	AppBskyEmbedRecordWithMedia,
	AppBskyFeedDefs,
	AppBskyFeedPost,
	AppBskyFeedThreadgate,
	type AtpAgentLoginOpts,
	type AtpAgentOpts,
	AtpServiceClient,
	type AtpSessionData,
	AtUri,
	BskyAgent,
	type ComAtprotoServerCreateSession,
	type ComAtprotoServerGetSession,
	RichText,
} from "@atproto/api";
import { RateLimiter } from "limiter";
import QuickLRU from "quick-lru";
import { List } from "../struct/List";
import { Post } from "../struct/post/Post";
import type { PostPayload } from "../struct/post/PostPayload";
import { Profile } from "../struct/Profile";
import { typedEntries } from "../util";
import { CacheOptions, makeCache } from "./cache";

const NO_SESSION_ERROR = "Active session not found. Make sure to call the login method first.";

const NOT_LIMITED_METHODS = ["createSession", "getSession"];

/**
 * Options for the Bot constructor
 */
export interface BotOptions extends Partial<AtpAgentOpts> {
	/** The default list of languages to attach to posts */
	langs?: Array<string>;

	/** Options for the built-in rate limiter */
	rateLimitOptions?: RateLimitOptions;

	/** Options for the request cache */
	cacheOptions?: CacheOptions;
}

/**
 * A bot that can interact with the Bluesky API
 */
export class Bot {
	/** The agent used to communicate with the Bluesky API */
	agent: BskyAgent;

	/** A limiter to rate limit API requests */
	limiter: RateLimiter;

	/** A cache to store API responses */
	cache: BotCache;

	/** The Bluesky API client, with rate-limited methods */
	api: AtpServiceClient;

	/** The default list of languages to attach to posts */
	langs: Array<string> = [];

	/** The bot account's Bluesky profile */
	profile!: Profile;

	constructor({ langs, rateLimitOptions, cacheOptions, ...options }: BotOptions = {}) {
		this.agent = new BskyAgent({ service: "https://bsky.social", ...options });

		if (langs) this.langs = langs;

		this.limiter = new RateLimiter({
			tokensPerInterval: rateLimitOptions?.rateLimit ?? 3000,
			interval: (rateLimitOptions?.rateLimitInterval ?? 300) * 1000,
		});

		this.cache = {
			profiles: makeCache(cacheOptions),
			posts: makeCache(cacheOptions),
			lists: makeCache({ maxEntries: 100, ...cacheOptions }),
		};

		this.agent.api = this.api = {
			// @ts-expect-error — Hacky way to rate limit API methods
			app: wrapApiWithLimiter(this.agent.api.app, this.limiter),
			// @ts-expect-error — Hacky way to rate limit API methods
			com: wrapApiWithLimiter(this.agent.api.com, this.limiter),
		};
	}

	/**
	 * Log in with an identifier and password
	 * @param identifier The bot account's email, handle, or DID
	 * @param password The bot account's password
	 */
	async login(
		{ identifier, password }: AtpAgentLoginOpts,
	): Promise<ComAtprotoServerCreateSession.OutputSchema>;
	/**
	 * Log in with an existing session
	 * @param session Must have a valid refreshJwt and accessJwt
	 */
	async login(session: AtpSessionData): Promise<ComAtprotoServerGetSession.OutputSchema>;
	async login(
		options: AtpAgentLoginOpts | AtpSessionData,
	): Promise<
		ComAtprotoServerGetSession.OutputSchema | ComAtprotoServerCreateSession.OutputSchema
	> {
		let response;

		if ("accessJwt" in options && "refreshJwt" in options) {
			// Try resuming if session data is provided
			const resumeSessionResponse = await this.agent.resumeSession(options);
			if (!resumeSessionResponse.success) {
				throw new Error(
					"Provided session data is invalid, try logging in with identifier & password instead.",
				);
			}

			response = resumeSessionResponse.data;
		} else if ("identifier" in options && "password" in options) {
			// Try logging in with identifier & password
			if (options.identifier[0] === "@") {
				options.identifier = options.identifier.slice(1);
			}

			const loginResponse = await this.agent.login(options);
			if (!loginResponse.success) {
				throw new Error("Failed to log in — double check your credentials and try again.");
			}

			response = loginResponse.data;
		}

		if (!response) {
			throw new Error(
				"Invalid login options. You must provide either session data or an identifier & password.",
			);
		}

		this.profile = await this.getProfile(response.did).catch((e) => {
			throw new Error("Failed to fetch bot profile. Error:\n" + e);
		});

		return response;
	}

	/**
	 * Fetch a post by its AT URI
	 * @param uri The post's AT URI
	 * @param options Optional configuration
	 */
	async getPost(uri: string, options: BotGetPostOptions = {}): Promise<Post> {
		options = { parentHeight: 1, depth: 1, ...options };

		if (!options.skipCache && this.cache.posts.has(uri)) return this.cache.posts.get(uri)!;

		const postThread = await this.agent.getPostThread({
			uri,
			parentHeight: options.parentHeight!,
			depth: options.depth!,
		});
		if (!postThread.success) {
			throw new Error("Failed to fetch post\n" + JSON.stringify(postThread.data));
		}

		if (!AppBskyFeedDefs.isThreadViewPost(postThread.data.thread)) {
			throw new Error(`Could not find post ${uri}`);
		}

		const post = Post.fromThreadView(postThread.data.thread, this);

		this.cache.posts.set(uri, post);
		return post;
	}

	/**
	 * Fetch up to 25 posts by their AT URIs
	 * @param uris The URIs of the posts to fetch
	 * @param options Optional configuration
	 */
	async getPosts(uris: Array<string>, options: BotGetPostsOptions = {}): Promise<Array<Post>> {
		if (!uris.length) return [];
		if (uris.length > 25) throw new Error("You can only fetch up to 25 posts at a time");

		if (!options.skipCache && uris.every((uri) => this.cache.posts.has(uri))) {
			return uris.map((uri) => this.cache.posts.get(uri)!);
		}

		const postViews = await this.api.app.bsky.feed.getPosts({ uris });
		if (!postViews.success) {
			throw new Error("Failed to fetch posts\n" + JSON.stringify(postViews.data));
		}

		const posts: Array<Post> = [];
		for (const postView of postViews.data.posts) {
			if (!AppBskyFeedPost.isRecord(postView.record)) continue;
			const post = Post.fromView(postView, this);
			this.cache.posts.set(post.uri, post);
			posts.push(post);
		}

		return posts;
	}

	/**
	 * Fetch up to 100 posts by a user's DID
	 * @param did The user's DID
	 * @param options Optional configuration
	 * @returns The user's posts and, if there are more posts to fetch, a cursor
	 */
	async getUserPosts(
		did: string,
		options: BotGetUserPostsOptions,
	): Promise<{ cursor: string | undefined; posts: Array<Post> }> {
		const response = await this.api.app.bsky.feed.getAuthorFeed({ actor: did, ...options });
		if (!response.success) {
			throw new Error("Failed to fetch user posts\n" + JSON.stringify(response.data));
		}

		const posts: Array<Post> = [];
		for (const feedViewPost of response.data.feed) {
			const post = Post.fromView(feedViewPost.post, this);
			this.cache.posts.set(post.uri, post);
			posts.push(post);
		}

		return { cursor: response.data.cursor, posts };
	}

	/**
	 * Fetch up to 100 posts liked by a user
	 * @param did The user's DID
	 * @param options Optional configuration
	 */
	async getUserLikes(
		did: string,
		options: BotGetUserLikesOptions,
	): Promise<{ cursor: string | undefined; posts: Array<Post> }> {
		const response = await this.api.app.bsky.feed.getActorLikes({ actor: did, ...options });
		if (!response.success) {
			throw new Error("Failed to fetch user likes\n" + JSON.stringify(response.data));
		}

		const posts: Array<Post> = [];
		for (const feedViewPost of response.data.feed) {
			const post = Post.fromView(feedViewPost.post, this);
			this.cache.posts.set(post.uri, post);
			posts.push(post);
		}

		return { cursor: response.data.cursor, posts };
	}

	/**
	 * Fetch a profile by DID or handle
	 * @param didOrHandle The user's DID or handle
	 * @param options Optional configuration
	 */
	async getProfile(didOrHandle: string, options: BotGetProfileOptions = {}): Promise<Profile> {
		if (!options.skipCache && this.cache.profiles.has(didOrHandle)) {
			return this.cache.profiles.get(didOrHandle)!;
		}

		const profileView = await this.api.app.bsky.actor.getProfile({ actor: didOrHandle });
		if (!profileView.success) {
			throw new Error(
				`Failed to fetch profile ${didOrHandle}\n` + JSON.stringify(profileView.data),
			);
		}

		const profile = Profile.fromView(profileView.data, this);
		this.cache.profiles.set(didOrHandle, profile);
		return profile;
	}

	/**
	 * Fetch a list by its AT URI
	 * @param uri The list's AT URI
	 * @param options Optional configuration
	 */
	async getList(uri: string, options?: BotGetListOptions): Promise<List> {
		if (!options?.skipCache && this.cache.lists.has(uri)) {
			return this.cache.lists.get(uri)!;
		}

		const listResponse = await this.api.app.bsky.graph.getList({ list: uri });
		if (!listResponse.success) {
			throw new Error("Failed to fetch list\n" + JSON.stringify(listResponse.data));
		}

		const list = List.fromView(listResponse.data.list, this);
		this.cache.lists.set(uri, list);
		return list;
	}

	/**
	 * Fetch all (up to 100) lists created by a user
	 * @param did The user's DID
	 * @param options Optional configuration
	 */
	async getUserLists(
		did: string,
		options: BotGetUserListsOptions,
	): Promise<{ cursor: string | undefined; lists: Array<List> }> {
		const response = await this.api.app.bsky.graph.getLists({ actor: did, ...options });
		if (!response.success) {
			throw new Error("Failed to fetch user lists\n" + JSON.stringify(response.data));
		}

		const lists: Array<List> = [];
		for (const listView of response.data.lists) {
			const list = List.fromView(listView, this);
			this.cache.lists.set(list.uri, list);
			lists.push(list);
		}

		return { cursor: response.data.cursor, lists };
	}

	/**
	 * Create a post
	 * @param payload The post to create
	 * @param options Optional configuration
	 */
	async post(
		payload: PostPayload,
		options?: BotPostOptions,
	): Promise<{ uri: string; cid: string }>;
	async post(
		payload: PostPayload,
		options: BotPostOptions & { fetchAfterCreate: true },
	): Promise<Post>;
	async post(
		payload: PostPayload,
		options: BotPostOptions = {},
	): Promise<Post | { uri: string; cid: string }> {
		options = { resolveFacets: true, ...options };

		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);

		// Use default langs if none are provided (an explicit empty array will be ignored)
		payload.langs ??= this.langs;
		payload.createdAt ??= new Date();

		// Resolve facets if necessary
		const richText = new RichText({ text: payload.text, facets: payload.facets ?? [] });
		if (options.resolveFacets && !payload.facets?.length) {
			await richText.detectFacets(this.agent);
		}

		// Create post labels
		const labels = payload.labels?.length
			? {
				$type: "com.atproto.label.defs#selfLabels",
				values: payload.labels.map((label) => ({ val: label })),
			}
			: undefined;

		// I'm not entirely sure how true this is but it's the case for posts made with the official client, at least
		if (payload.images?.length && payload.quoted && !(payload.quoted instanceof Post)) {
			throw new Error("Only a post can be embedded alongside images");
		}

		// Upload image blobs
		const images: Array<AppBskyEmbedImages.Image> = [];
		if (payload.images?.length) {
			for (const image of payload.images) {
				if (!image?.data.byteLength) throw new Error("Can't upload an empty image");

				image.alt ??= "";

				const imageResponse = await this.api.com.atproto.repo.uploadBlob(image.data);
				if (!imageResponse.success) {
					throw new Error(
						"Failed to upload image\n" + JSON.stringify(imageResponse.data),
					);
				}

				const { blob } = imageResponse.data;
				images.push({ ...image, alt: image.alt, image: blob });
			}
		}

		// Construct the post embed
		let embed:
			| AppBskyEmbedImages.Main
			| AppBskyEmbedExternal.Main
			| AppBskyEmbedRecord.Main
			| AppBskyEmbedRecordWithMedia.Main
			| undefined;

		if (payload.quoted) {
			const record: AppBskyEmbedRecord.Main = {
				$type: "app.bsky.embed.record",
				record: { uri: payload.quoted.uri, cid: payload.quoted.cid },
			};
			embed = images.length
				? {
					$type: "app.bsky.embed.recordWithMedia",
					record,
					media: { $type: "app.bsky.embed.images", images },
				}
				: record;
		} else if (payload.external) {
			embed = {
				$type: "app.bsky.embed.external",
				external: {
					title: payload.external.title,
					uri: payload.external.uri,
					description: payload.external.description,
				},
			};

			if (payload.external.thumb?.data.byteLength) {
				const thumbResponse = await this.api.com.atproto.repo.uploadBlob(
					payload.external.thumb.data,
				);
				if (!thumbResponse.success) {
					throw new Error(
						"Failed to upload thumbnail\n" + JSON.stringify(thumbResponse.data),
					);
				}
				embed.external.thumb = thumbResponse.data.blob;
			}
		} else if (images.length) {
			embed = { $type: "app.bsky.embed.images", images };
		}

		// Put together the post record
		const postRecord: AppBskyFeedPost.Record = {
			$type: "app.bsky.feed.post",
			text: richText.text,
			facets: richText.facets ?? [],
			createdAt: payload.createdAt.toISOString(),
			langs: payload.langs,
		};
		if (payload.replyRef) postRecord.reply = payload.replyRef;
		if (embed) postRecord.embed = embed;
		if (labels) postRecord.labels = labels;
		if (payload.tags?.length) postRecord.tags = payload.tags;

		const postResponse = await this.api.com.atproto.repo.createRecord({
			collection: "app.bsky.feed.post",
			repo: this.profile.did,
			record: postRecord,
		});
		if (!postResponse.success) {
			throw new Error("Failed to create post\n" + JSON.stringify(postResponse.data));
		}

		// Threadgate is a separate record
		if (payload.threadgate) {
			const { rkey } = new AtUri(postResponse.data.uri);
			const allow: AppBskyFeedThreadgate.Record["allow"] = [];

			if (payload.threadgate.allowFollowing) {
				allow.push({ $type: "app.bsky.feed.threadgate#followingRule" });
			}
			if (payload.threadgate.allowMentioned) {
				allow.push({ $type: "app.bsky.feed.threadgate#mentionRule" });
			}
			payload.threadgate.allowLists?.forEach((list) => {
				allow.push({
					$type: "app.bsky.feed.threadgate#listRule",
					list: typeof list === "string" ? list : list.uri,
				});
			});

			const threadgateRecord: AppBskyFeedThreadgate.Record = {
				$type: "app.bsky.feed.threadgate",
				createdAt: new Date().toISOString(),
				post: postResponse.data.uri,
				allow,
			};

			const threadgateResponse = await this.api.com.atproto.repo.createRecord({
				collection: "app.bsky.feed.threadgate",
				repo: this.profile.did,
				rkey, // threadgate rkey must match post rkey
				record: threadgateRecord,
			});
			if (!threadgateResponse.success) {
				throw new Error(
					"Failed to create threadgate\n" + JSON.stringify(threadgateResponse.data),
				);
			}
		}

		if (!options.fetchAfterCreate) {
			return { uri: postResponse.data.uri, cid: postResponse.data.cid };
		}

		const createdPost = await this.getPost(postResponse.data.uri);
		this.cache.posts.set(createdPost.uri, createdPost);
		return createdPost;
	}

	/**
	 * Delete a post
	 * @param uri The post's AT URI
	 */
	async deletePost(uri: string): Promise<void> {
		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);
		await this.agent.deletePost(uri);
		this.cache.posts.delete(uri);
	}

	/**
	 * Like a post or feed generator
	 * @param uri The post's AT URI
	 * @param cid The post's CID
	 * @returns The like's AT URI
	 */
	async like({ uri, cid }: { uri: string; cid: string }): Promise<string> {
		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);
		const like = await this.agent.like(uri, cid);
		return like.uri;
	}

	/**
	 * Delete a like
	 * @param uri The like's AT URI
	 */
	async deleteLike(uri: string): Promise<void> {
		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);
		await this.agent.deleteLike(uri);
	}
	/** @see Bot#deleteLike */
	unlike = this.deleteLike.bind(this);

	/**
	 * Repost a post
	 * @param uri The post's AT URI
	 * @param cid The post's CID
	 * @returns The repost's AT URI
	 */
	async repost({ uri, cid }: { uri: string; cid: string }): Promise<string> {
		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);
		const repost = await this.agent.repost(uri, cid);
		return repost.uri;
	}

	/**
	 * Delete a repost
	 * @param uri The repost's AT URI
	 */
	async deleteRepost(uri: string): Promise<void> {
		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);
		await this.agent.deleteRepost(uri);
	}

	/**
	 * Follow a user
	 * @param did The user's DID
	 * @returns The follow's AT URI
	 */
	async follow(did: string): Promise<string> {
		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);
		const follow = await this.agent.follow(did);
		return follow.uri;
	}

	/**
	 * Delete a follow
	 * @param did The user's DID
	 */
	async deleteFollow(did: string): Promise<void> {
		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);
		await this.agent.deleteFollow(did);
	}
	/** @see Bot#deleteFollow */
	unfollow = this.deleteFollow.bind(this);

	/**
	 * Mute a user
	 * @param did The user's DID
	 */
	async mute(did: string): Promise<void> {
		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);
		await this.agent.mute(did);
	}

	/**
	 * Delete a mute
	 * @param did The user's DID
	 */
	async deleteMute(did: string): Promise<void> {
		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);
		await this.agent.unmute(did);
	}
	/** @see Bot#deleteMute */
	unmute = this.deleteMute.bind(this);

	/**
	 * Block a user
	 * @param did The user's DID
	 */
	async block(did: string): Promise<string> {
		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);
		const block = await this.agent.api.app.bsky.graph.block.create({ repo: did }, {
			$type: "app.bsky.graph.block",
			subject: did,
			createdAt: new Date().toISOString(),
		});
		return block.uri;
	}

	/**
	 * Delete a block
	 * @param uri The block's AT URI
	 */
	async deleteBlock(uri: string): Promise<void> {
		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);
		await this.agent.api.app.bsky.graph.block.delete({ uri });
	}

	/**
	 * Resolve a handle to a DID
	 * @param handle The handle to resolve
	 */
	async resolveHandle(handle: string): Promise<string> {
		const response = await this.api.com.atproto.identity.resolveHandle({ handle });
		if (!response.success) {
			throw new Error("Failed to resolve handle\n" + JSON.stringify(response.data));
		}
		return response.data.did;
	}

	/**
	 * Update the bot's handle
	 * @param handle The new handle
	 */
	async updateHandle(handle: string): Promise<void> {
		if (!this.agent.hasSession) throw new Error(NO_SESSION_ERROR);
		const { success } = await this.api.com.atproto.identity.updateHandle({ handle });
		if (!success) {
			throw new Error("Failed to update handle");
		}
		this.profile.handle = handle;
	}
}

function wrapApiWithLimiter<
	T extends Record<string, ((...args: unknown[]) => never) | Record<string, never>>,
>(api: T, limiter: RateLimiter): T {
	// Rate limit API methods by wrapping each method with a function that will remove a token from the limiter
	for (const [key, value] of typedEntries(api)) {
		if (key === "_service") continue;
		if (typeof value === "function") {
			// @ts-expect-error — Hacky way to rate limit API methods
			api[key] = async (input: unknown) => {
				if (NOT_LIMITED_METHODS.includes(key)) return value(input);

				// If there are 0 tokens remaining, this call will block until the interval resets
				await limiter.removeTokens(1);
				return value(input);
			};
		} else if (typeof value === "object") {
			wrapApiWithLimiter(value, limiter);
		}
	}
	return api;
}

/**
 * The bot's cache
 */
export interface BotCache {
	profiles: QuickLRU<string, Profile>;
	posts: QuickLRU<string, Post>;
	lists: QuickLRU<string, List>;
}

/**
 * Options for the built-in rate limiter
 */
export interface RateLimitOptions {
	/**
	 * The maximum number of requests that can be made to the Bluesky API in a given interval.
	 * Don't set this unless you know what you're doing.
	 * @default 3000
	 * @see https://www.docs.bsky.app/docs/advanced-guides/rate-limits
	 */
	rateLimit?: number;

	/**
	 * The interval after which the rate limit will reset, in seconds
	 * @default 300
	 * @see https://www.docs.bsky.app/docs/advanced-guides/rate-limits
	 */
	rateLimitInterval?: number;
}

/**
 * Base options for any Bot method that fetches data
 */
export interface BaseBotGetMethodOptions {
	/**
	 * Whether to skip checking the cache
	 * @default false
	 */
	skipCache?: boolean;
}

/**
 * Options for the Bot#getPost method
 */
export interface BotGetPostOptions extends BaseBotGetMethodOptions {
	/**
	 * How many levels of parent posts to fetch
	 * @default 1
	 */
	parentHeight?: number;

	/**
	 * How many levels of child posts to fetch
	 * @default 1
	 */
	depth?: number;
}

/**
 * Options for the Bot#getPosts method
 */
export interface BotGetPostsOptions extends BaseBotGetMethodOptions {}

/**
 * Post types to include in the response to Bot#getUserPosts
 */
export const GetUserPostsFilter = {
	/** All posts */
	PostsWithReplies: "posts_with_replies",
	/** Top-level posts only */
	PostsNoReplies: "posts_no_replies",
	/** Posts with media */
	PostsWithMedia: "posts_with_media",
	/** Top-level posts and threads where the only author is the user */
	PostsAndAuthorThreads: "posts_and_author_threads",
};
export type GetUserPostsFilter = typeof GetUserPostsFilter[keyof typeof GetUserPostsFilter];

/**
 * Options for the Bot#getUserPosts method
 */
export interface BotGetUserPostsOptions {
	/**
	 * The maximum number of posts to fetch (up to 100, inclusive)
	 * @default 50
	 */
	limit?: number;

	/**
	 * The offset at which to start fetching posts
	 */
	cursor?: string;

	/**
	 * Post type to include in the response
	 * @default GetUserPostsFilter.PostsWithReplies
	 */
	filter?: GetUserPostsFilter;
}

/**
 * Options for the Bot#getUserLikes method
 */
export interface BotGetUserLikesOptions {
	/**
	 * The maximum number of posts to fetch (up to 100, inclusive)
	 * @default 50
	 */
	limit?: number;

	/**
	 * The offset at which to start fetching posts
	 */
	cursor?: string;
}

/**
 * Options for the Bot#getProfile method
 */
export interface BotGetProfileOptions extends BaseBotGetMethodOptions {}

/**
 * Options for the Bot#getList method
 */
export interface BotGetListOptions extends BaseBotGetMethodOptions {}

/**
 * Options for the Bot#getUserLists method
 */
export interface BotGetUserListsOptions {
	/**
	 * The maximum number of lists to fetch (up to 100, inclusive)
	 * @default 50
	 */
	limit?: number;

	/**
	 * The offset at which to start fetching lists
	 */
	cursor?: string;
}

/**
 * Options for the Bot#post method
 */
export interface BotPostOptions {
	/**
	 * Whether to automatically resolve facets in the post's text.
	 * This will be ignored if the provided post data already has facets attached
	 * @default true
	 */
	resolveFacets?: boolean;

	/**
	 * Whether to fetch the post after creating it.
	 * If set to true, this method will return a Post class. Otherwise, it will only return the post's URI and CID.
	 * @default false
	 */
	fetchAfterCreate?: boolean;
}
