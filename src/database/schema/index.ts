import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  pgEnum,
  uniqueIndex,
  index,
  jsonb,
  real,
  date,
  customType,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// Import and re-export auth schema
import { user, session, account, verification } from './auth';
export { user, session, account, verification };

// Enums
export const comicTypeEnum = pgEnum('comic_type', ['manga', 'manhwa', 'manhua']);
export const comicStatusEnum = pgEnum('comic_status', ['ongoing', 'completed', 'hiatus', 'cancelled']);
export const bookmarkStatusEnum = pgEnum('bookmark_status', ['reading', 'completed', 'dropped', 'plan_to_read']);
export const languageEnum = pgEnum('language', ['en', 'es', 'pt']);
export const userPlanEnum = pgEnum('user_plan', ['basic', 'premium']);
// Keep enum order aligned with the existing Postgres type to avoid destructive Drizzle diffs.
export const premiumCycleEnum = pgEnum('premium_cycle', ['1m', '3m', '6m', '1w']);
export const entityReactionTargetEnum = pgEnum('entity_reaction_target', ['comic', 'chapter']);
export const entityReactionTypeEnum = pgEnum('entity_reaction_type', ['upvote', 'funny', 'love', 'surprised', 'angry', 'sad']);
export const mediaAssetSourceEnum = pgEnum('media_asset_source', ['uploaded', 'external']);
export const mediaAssetTypeEnum = pgEnum('media_asset_type', ['image', 'gif', 'sticker']);
export const storageProviderEnum = pgEnum('storage_provider', ['s3', 'r2']);

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

// Profiles (linked to better-auth user)
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  visibleName: varchar('visible_name', { length: 100 }),
  username: varchar('username', { length: 50 }).unique().notNull(),
  bio: text('bio'),
  avatarUrl: varchar('avatar_url', { length: 500 }),
  language: languageEnum('language').default('es'),
  userId: text('user_id').unique().notNull().references(() => user.id, { onDelete: 'cascade' }),
  dateOfBirth: date('date_of_birth'),
  isBanned: boolean('is_banned').default(false),
  isAdultContent: boolean('is_adult_content').default(false),
  plan: userPlanEnum('plan').default('basic'),
  premiumSource: text('premium_source').$type<'stripe' | 'manual' | null>(),
  premiumCycle: premiumCycleEnum('premium_cycle'),
  premiumStartedAt: timestamp('premium_started_at'),
  premiumExpireAt: timestamp('premium_expire_at'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  stripePriceId: text('stripe_price_id'),
  stripeProductId: text('stripe_product_id'),
  stripeProductName: text('stripe_product_name'),
  stripePriceLabel: text('stripe_price_label'),
  stripeSubscriptionStatus: text('stripe_subscription_status'),
  stripeCancelAtPeriodEnd: boolean('stripe_cancel_at_period_end').default(false),
  stripeCanceledAt: timestamp('stripe_canceled_at'),
  stripeCurrentPeriodStart: timestamp('stripe_current_period_start'),
  stripeCurrentPeriodEnd: timestamp('stripe_current_period_end'),
  stripeLastSyncedAt: timestamp('stripe_last_synced_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  usernameIdx: uniqueIndex('profiles_username_idx').on(table.username),
  userIdIdx: uniqueIndex('profiles_user_id_idx').on(table.userId),
  stripeCustomerIdIdx: index('profiles_stripe_customer_idx').on(table.stripeCustomerId),
  stripeSubscriptionIdIdx: index('profiles_stripe_subscription_idx').on(table.stripeSubscriptionId),
}));

export const premiumRefundRequests = pgTable('premium_refund_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  stripeSubscriptionId: text('stripe_subscription_id').notNull(),
  stripeCustomerId: text('stripe_customer_id'),
  reason: text('reason').notNull(),
  status: text('status').$type<'pending' | 'reviewing' | 'approved' | 'rejected'>().notNull().default('pending'),
  adminNote: text('admin_note'),
  resolvedByAdminId: text('resolved_by_admin_id'),
  resolvedAt: timestamp('resolved_at'),
  plan: userPlanEnum('plan').notNull().default('premium'),
  cycle: premiumCycleEnum('cycle'),
  paymentMethod: text('payment_method').$type<'stripe' | 'other' | null>(),
  currentPeriodEnd: timestamp('current_period_end'),
  priceLabel: text('price_label'),
  productName: text('product_name'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  profileIdIdx: index('premium_refund_requests_profile_idx').on(table.profileId),
  userIdIdx: index('premium_refund_requests_user_idx').on(table.userId),
  stripeSubscriptionIdIdx: index('premium_refund_requests_subscription_idx').on(table.stripeSubscriptionId),
  statusIdx: index('premium_refund_requests_status_idx').on(table.status),
  createdAtIdx: index('premium_refund_requests_created_at_idx').on(table.createdAt),
}));

// Genres
export const genres = pgTable('genres', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: varchar('name', { length: 100 }).unique().notNull(),
  slug: varchar('slug', { length: 100 }).unique().notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// Scan Groups
export const scanGroups = pgTable('scan_groups', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).unique().notNull(),
  website: varchar('website', { length: 500 }),
  createdAt: timestamp('created_at').defaultNow(),
});

// Comics
export const comics = pgTable('comics', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  title: varchar('title', { length: 500 }).notNull(),
  titleAlternative: varchar('title_alternative', { length: 500 }),
  slug: varchar('slug', { length: 500 }).unique().notNull(),
  author: varchar('author', { length: 255 }),
  artist: varchar('artist', { length: 255 }),
  description: text('description'),
  type: comicTypeEnum('type').default('manga'),
  coverImage: varchar('cover_image', { length: 1000 }),
  status: comicStatusEnum('status').default('ongoing'),
  views: integer('views').default(0),
  likes: integer('likes').default(0),
  reactionsTotal: integer('reactions_total').default(0).notNull(),
  reactionsSummary: jsonb('reactions_summary')
    .$type<Record<'upvote' | 'funny' | 'love' | 'surprised' | 'angry' | 'sad', number>>()
    .default(
      sql`'{"upvote":0,"funny":0,"love":0,"surprised":0,"angry":0,"sad":0}'::jsonb`,
    )
    .notNull(),
  followers: integer('followers').default(0),
  protectedRouteEnabled: boolean('protected_route_enabled').default(false).notNull(),
  isNsfw: boolean('is_nsfw').default(false),
  isHentai: boolean('is_hentai').default(false),
  copyrighted: boolean('copyrighted').default(false),
  // Managed by the manual full-text-search trigger created in 0003_fulltext_search.sql.
  searchVector: tsvector('search_vector'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  slugIdx: index('comics_slug_idx').on(table.slug),
  searchVectorIdx: index('comics_search_vector_idx').using('gin', table.searchVector.asc().nullsLast().op('tsvector_ops')),
  titleIdx: index('comics_title_idx').on(table.title),
  titleTrgmIdx: index('comics_title_trgm_idx').using('gin', table.title.asc().nullsLast().op('gin_trgm_ops')),
  titleAlternativeTrgmIdx: index('comics_title_alt_trgm_idx').using('gin', table.titleAlternative.asc().nullsLast().op('gin_trgm_ops')),
  statusIdx: index('comics_status_idx').on(table.status),
  isHentaiIdx: index('comics_is_hentai_idx').on(table.isHentai),
}));

// Comic Scans (relation between comics and scan groups)
export const comicScans = pgTable('comic_scans', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  scanGroupId: integer('scan_group_id').references(() => scanGroups.id, { onDelete: 'cascade' }).notNull(),
  externalId: varchar('external_id', { length: 255 }),
  externalUrl: varchar('external_url', { length: 1000 }),
  language: languageEnum('language').default('es'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  comicScanIdx: uniqueIndex('comic_scans_comic_scan_idx').on(table.comicId, table.scanGroupId),
}));

// Comic Genres (many-to-many)
export const comicGenres = pgTable('comic_genres', {
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  genreId: integer('genre_id').references(() => genres.id, { onDelete: 'cascade' }).notNull(),
}, (table) => ({
  pk: uniqueIndex('comic_genres_pk').on(table.comicId, table.genreId),
}));

// Chapters
export const chapters = pgTable('chapters', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  comicScanId: integer('comic_scan_id').references(() => comicScans.id, { onDelete: 'cascade' }).notNull(),
  chapterNumber: real('chapter_number').notNull(),
  title: varchar('title', { length: 500 }),
  slug: varchar('slug', { length: 500 }).notNull(),
  releaseDate: timestamp('release_date'),
  urlPages: jsonb('url_pages').$type<string[]>().default([]),
  views: integer('views').default(0),
  likes: integer('likes').default(0),
  reactionsTotal: integer('reactions_total').default(0).notNull(),
  reactionsSummary: jsonb('reactions_summary')
    .$type<Record<'upvote' | 'funny' | 'love' | 'surprised' | 'angry' | 'sad', number>>()
    .default(
      sql`'{"upvote":0,"funny":0,"love":0,"surprised":0,"angry":0,"sad":0}'::jsonb`,
    )
    .notNull(),
  copyrighted: boolean('copyrighted').default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  comicScanIdx: index('chapters_comic_scan_idx').on(table.comicScanId),
  comicChapterIdx: uniqueIndex('chapters_comic_chapter_idx').on(table.comicScanId, table.chapterNumber),
}));

// Bookmarks
export const bookmarks = pgTable('bookmarks', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  status: bookmarkStatusEnum('status').default('plan_to_read'),
  isFavorite: boolean('is_favorite').default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  profileComicIdx: uniqueIndex('bookmarks_profile_comic_idx').on(table.profileId, table.comicId),
  profileStatusIdx: index('bookmarks_profile_status_idx').on(table.profileId, table.status),
}));

// Reading History
export const readingHistory = pgTable('reading_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  chapterId: integer('chapter_id').references(() => chapters.id, { onDelete: 'cascade' }).notNull(),
  progressPercentage: integer('progress_percentage').default(0),
  readAt: timestamp('read_at').defaultNow(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  profileComicChapterIdx: uniqueIndex('reading_history_profile_comic_chapter_idx').on(table.profileId, table.comicId, table.chapterId),
  profileIdx: index('reading_history_profile_idx').on(table.profileId),
  readAtIdx: index('reading_history_read_at_idx').on(table.readAt),
}));

// Traffic Events - raw learning signals for suspicious bot/datacenter behavior.
// This is intentionally text/json driven so we can evolve detection rules without
// destructive enum migrations while we learn from production traffic.
export const trafficEvents = pgTable('traffic_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  occurredAt: timestamp('occurred_at').defaultNow().notNull(),
  eventType: text('event_type').notNull(),
  action: text('action').notNull().default('allow'),
  subjectKey: text('subject_key').notNull(),
  clientIp: varchar('client_ip', { length: 64 }),
  clientAsn: integer('client_asn'),
  userAgent: text('user_agent'),
  path: text('path'),
  method: varchar('method', { length: 16 }),
  referer: text('referer'),
  acceptLanguage: text('accept_language'),
  userId: text('user_id'),
  searchQuery: text('search_query'),
  entityType: text('entity_type'),
  entityId: integer('entity_id'),
  riskScore: integer('risk_score').default(0).notNull(),
  reasons: jsonb('reasons').$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
}, (table) => ({
  occurredAtIdx: index('traffic_events_occurred_at_idx').on(table.occurredAt),
  subjectOccurredAtIdx: index('traffic_events_subject_occurred_idx').on(table.subjectKey, table.occurredAt),
  clientIpOccurredAtIdx: index('traffic_events_client_ip_occurred_idx').on(table.clientIp, table.occurredAt),
  clientAsnOccurredAtIdx: index('traffic_events_client_asn_occurred_idx').on(table.clientAsn, table.occurredAt),
  eventTypeOccurredAtIdx: index('traffic_events_event_type_occurred_idx').on(table.eventType, table.occurredAt),
  riskScoreOccurredAtIdx: index('traffic_events_risk_score_occurred_idx').on(table.riskScore, table.occurredAt),
}));

// Likes - Para trackear qué usuario dio like a qué comic
export const likes = pgTable('likes', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  profileComicIdx: uniqueIndex('likes_profile_comic_idx').on(table.profileId, table.comicId),
  profileIdx: index('likes_profile_idx').on(table.profileId),
  comicIdx: index('likes_comic_idx').on(table.comicId),
}));

// Chapter Likes - Para trackear qué usuario dio like a qué capítulo
export const chapterLikes = pgTable('chapter_likes', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  chapterId: integer('chapter_id').references(() => chapters.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  profileChapterIdx: uniqueIndex('chapter_likes_profile_chapter_idx').on(table.profileId, table.chapterId),
  profileIdx: index('chapter_likes_profile_idx').on(table.profileId),
  chapterIdx: index('chapter_likes_chapter_idx').on(table.chapterId),
}));

// Comments - Sistema de comentarios con respuestas anidadas
export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  chapterId: integer('chapter_id').references(() => chapters.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id'),
  content: text('content').notNull(),
  upvotesCount: integer('upvotes_count').default(0).notNull(),
  downvotesCount: integer('downvotes_count').default(0).notNull(),
  score: integer('score').default(0).notNull(),
  isEdited: boolean('is_edited').default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  profileIdx: index('comments_profile_idx').on(table.profileId),
  comicIdx: index('comments_comic_idx').on(table.comicId),
  chapterIdx: index('comments_chapter_idx').on(table.chapterId),
  parentIdx: index('comments_parent_idx').on(table.parentId),
  chapterScoreIdx: index('comments_chapter_score_idx').on(table.chapterId, table.parentId, table.score),
  comicScoreIdx: index('comments_comic_score_idx').on(table.comicId, table.parentId, table.score),
}));

export const commentVotes = pgTable('comment_votes', {
  id: uuid('id').primaryKey().defaultRandom(),
  commentId: uuid('comment_id')
    .references(() => comments.id, { onDelete: 'cascade' })
    .notNull(),
  profileId: uuid('profile_id')
    .references(() => profiles.id, { onDelete: 'cascade' })
    .notNull(),
  value: integer('value').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  commentProfileIdx: uniqueIndex('comment_votes_comment_profile_idx').on(table.commentId, table.profileId),
  profileIdx: index('comment_votes_profile_idx').on(table.profileId),
  commentIdx: index('comment_votes_comment_idx').on(table.commentId),
}));

export const entityReactions = pgTable('entity_reactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityType: entityReactionTargetEnum('entity_type').notNull(),
  entityId: integer('entity_id').notNull(),
  profileId: uuid('profile_id')
    .references(() => profiles.id, { onDelete: 'cascade' })
    .notNull(),
  reactionType: entityReactionTypeEnum('reaction_type').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  entityProfileIdx: uniqueIndex('entity_reactions_entity_profile_idx').on(table.entityType, table.entityId, table.profileId),
  entityIdx: index('entity_reactions_entity_idx').on(table.entityType, table.entityId),
  profileIdx: index('entity_reactions_profile_idx').on(table.profileId),
}));

export const mediaAssets = pgTable('media_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id')
    .references(() => profiles.id, { onDelete: 'cascade' })
    .notNull(),
  galleryVisible: boolean('gallery_visible').default(true).notNull(),
  sourceType: mediaAssetSourceEnum('source_type').notNull(),
  mediaType: mediaAssetTypeEnum('media_type').notNull(),
  storageProvider: storageProviderEnum('storage_provider'),
  storageKey: text('storage_key'),
  originalUrl: text('original_url'),
  mimeType: varchar('mime_type', { length: 150 }),
  width: integer('width'),
  height: integer('height'),
  sizeBytes: integer('size_bytes'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  profileIdx: index('media_assets_profile_idx').on(table.profileId),
  profileVisibleIdx: index('media_assets_profile_visible_idx').on(table.profileId, table.galleryVisible),
  sourceIdx: index('media_assets_source_idx').on(table.sourceType),
  storageKeyIdx: uniqueIndex('media_assets_storage_key_idx').on(table.storageKey),
}));

export const commentAttachments = pgTable('comment_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  commentId: uuid('comment_id')
    .references(() => comments.id, { onDelete: 'cascade' })
    .notNull(),
  mediaAssetId: uuid('media_asset_id')
    .references(() => mediaAssets.id, { onDelete: 'cascade' })
    .notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  commentMediaIdx: uniqueIndex('comment_attachments_comment_media_idx').on(table.commentId, table.mediaAssetId),
  commentIdx: index('comment_attachments_comment_idx').on(table.commentId),
  mediaIdx: index('comment_attachments_media_idx').on(table.mediaAssetId),
}));

// Playlists - Listas personalizadas de comics
export const playlists = pgTable('playlists', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  isPublic: boolean('is_public').default(false),
  coverImage: varchar('cover_image', { length: 500 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  profileIdx: index('playlists_profile_idx').on(table.profileId),
}));

// Playlist Items - Comics dentro de las playlists
export const playlistItems = pgTable('playlist_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  playlistId: uuid('playlist_id').references(() => playlists.id, { onDelete: 'cascade' }).notNull(),
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  order: integer('order').default(0),
  addedAt: timestamp('added_at').defaultNow(),
}, (table) => ({
  playlistComicIdx: uniqueIndex('playlist_items_playlist_comic_idx').on(table.playlistId, table.comicId),
  playlistIdx: index('playlist_items_playlist_idx').on(table.playlistId),
}));

// Comic Views History - Historial de vistas diarias
export const comicViewsHistory = pgTable('comic_views_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  views: integer('views').default(0).notNull(),
  date: date('date').notNull(), // Almacena solo la fecha
}, (table) => ({
  comicDateIdx: uniqueIndex('comic_views_history_comic_date_idx').on(table.comicId, table.date),
  dateIdx: index('comic_views_history_date_idx').on(table.date),
}));

// Relations
export const profilesRelations = relations(profiles, ({ many }) => ({
  bookmarks: many(bookmarks),
  readingHistory: many(readingHistory),
  likes: many(likes),
  chapterLikes: many(chapterLikes),
  comments: many(comments),
  commentVotes: many(commentVotes),
  entityReactions: many(entityReactions),
  mediaAssets: many(mediaAssets),
  playlists: many(playlists),
}));

export const comicsRelations = relations(comics, ({ many }) => ({
  comicScans: many(comicScans),
  comicGenres: many(comicGenres),
  bookmarks: many(bookmarks),
  readingHistory: many(readingHistory),
  likes: many(likes),
  comments: many(comments),
  playlistItems: many(playlistItems),
  viewsHistory: many(comicViewsHistory),
}));

export const comicScansRelations = relations(comicScans, ({ one, many }) => ({
  comic: one(comics, { fields: [comicScans.comicId], references: [comics.id] }),
  scanGroup: one(scanGroups, { fields: [comicScans.scanGroupId], references: [scanGroups.id] }),
  chapters: many(chapters),
}));

export const chaptersRelations = relations(chapters, ({ one, many }) => ({
  comicScan: one(comicScans, { fields: [chapters.comicScanId], references: [comicScans.id] }),
  readingHistory: many(readingHistory),
  comments: many(comments),
  chapterLikes: many(chapterLikes),
}));

export const bookmarksRelations = relations(bookmarks, ({ one }) => ({
  profile: one(profiles, { fields: [bookmarks.profileId], references: [profiles.id] }),
  comic: one(comics, { fields: [bookmarks.comicId], references: [comics.id] }),
}));

export const readingHistoryRelations = relations(readingHistory, ({ one }) => ({
  profile: one(profiles, { fields: [readingHistory.profileId], references: [profiles.id] }),
  comic: one(comics, { fields: [readingHistory.comicId], references: [comics.id] }),
  chapter: one(chapters, { fields: [readingHistory.chapterId], references: [chapters.id] }),
}));

export const genresRelations = relations(genres, ({ many }) => ({
  comicGenres: many(comicGenres),
}));

export const comicGenresRelations = relations(comicGenres, ({ one }) => ({
  comic: one(comics, { fields: [comicGenres.comicId], references: [comics.id] }),
  genre: one(genres, { fields: [comicGenres.genreId], references: [genres.id] }),
}));

export const scanGroupsRelations = relations(scanGroups, ({ many }) => ({
  comicScans: many(comicScans),
}));

// Likes relations
export const likesRelations = relations(likes, ({ one }) => ({
  profile: one(profiles, { fields: [likes.profileId], references: [profiles.id] }),
  comic: one(comics, { fields: [likes.comicId], references: [comics.id] }),
}));

// Chapter Likes relations
export const chapterLikesRelations = relations(chapterLikes, ({ one }) => ({
  profile: one(profiles, { fields: [chapterLikes.profileId], references: [profiles.id] }),
  chapter: one(chapters, { fields: [chapterLikes.chapterId], references: [chapters.id] }),
}));

// Comments relations
export const commentsRelations = relations(comments, ({ one, many }) => ({
  profile: one(profiles, { fields: [comments.profileId], references: [profiles.id] }),
  comic: one(comics, { fields: [comments.comicId], references: [comics.id] }),
  chapter: one(chapters, { fields: [comments.chapterId], references: [chapters.id] }),
  parent: one(comments, { fields: [comments.parentId], references: [comments.id], relationName: 'parentChild' }),
  replies: many(comments, { relationName: 'parentChild' }),
  votes: many(commentVotes),
  attachments: many(commentAttachments),
}));

export const commentVotesRelations = relations(commentVotes, ({ one }) => ({
  comment: one(comments, { fields: [commentVotes.commentId], references: [comments.id] }),
  profile: one(profiles, { fields: [commentVotes.profileId], references: [profiles.id] }),
}));

export const mediaAssetsRelations = relations(mediaAssets, ({ one, many }) => ({
  profile: one(profiles, { fields: [mediaAssets.profileId], references: [profiles.id] }),
  commentAttachments: many(commentAttachments),
}));

export const commentAttachmentsRelations = relations(commentAttachments, ({ one }) => ({
  comment: one(comments, { fields: [commentAttachments.commentId], references: [comments.id] }),
  mediaAsset: one(mediaAssets, { fields: [commentAttachments.mediaAssetId], references: [mediaAssets.id] }),
}));

export const entityReactionsRelations = relations(entityReactions, ({ one }) => ({
  profile: one(profiles, { fields: [entityReactions.profileId], references: [profiles.id] }),
}));

// Playlists relations
export const playlistsRelations = relations(playlists, ({ one, many }) => ({
  profile: one(profiles, { fields: [playlists.profileId], references: [profiles.id] }),
  items: many(playlistItems),
}));

// Playlist Items relations
export const playlistItemsRelations = relations(playlistItems, ({ one }) => ({
  playlist: one(playlists, { fields: [playlistItems.playlistId], references: [playlists.id] }),
  comic: one(comics, { fields: [playlistItems.comicId], references: [comics.id] }),
}));

// Comic Views History relations
export const comicViewsHistoryRelations = relations(comicViewsHistory, ({ one }) => ({
  comic: one(comics, { fields: [comicViewsHistory.comicId], references: [comics.id] }),
}));
