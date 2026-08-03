// The fixed mood/tone vocabulary for on-device mood search.
//
// Two jobs, and it is worth being clear that the SECOND one is the reason
// this file still exists:
//
// 1. Explainability. After a search, the UI shows which vocabulary tags the
//    query resolved to. Semantic similarity over free text is otherwise a
//    black box: the user types a sentence, some titles come back, and there
//    is no way to tell a good match from a broken model load. A small named
//    vocabulary gives the feature something honest to show.
//
// 2. A coarse fallback. Ranking is driven by per-title overview embeddings
//    (see titleIndex.ts), but a title whose overview has not been backfilled
//    yet has no vector. For those, the tag -> genre mapping below is the only
//    signal available, so mood search degrades to a genre filter for them
//    instead of dropping them silently.
//
// Honest limitation, stated once here rather than implied: TMDB's genre
// vocabulary has no Horror and no Thriller for TV (those exist only in the
// movie genre list; TV gets the broader "Sci-Fi & Fantasy" and "Mystery").
// So the genre fallback for a tag like "unsettling" is genuinely coarse on
// the show side. The embedding path is what actually distinguishes tone;
// the genre IDs are a floor, not the feature.

/** TMDB genre IDs. TV and movie lists overlap partially and are both included. */
const GENRE = {
  action: 28,
  actionAdventure: 10759,
  adventure: 12,
  animation: 16,
  comedy: 35,
  crime: 80,
  documentary: 99,
  drama: 18,
  family: 10751,
  fantasy: 14,
  history: 36,
  horror: 27,
  mystery: 9648,
  reality: 10764,
  romance: 10749,
  sciFi: 878,
  sciFiFantasy: 10765,
  thriller: 53,
  war: 10752,
  warPolitics: 10768,
  western: 37,
} as const;

export interface MoodTag {
  /** Stable identifier, also what the UI displays. */
  id: string;
  /**
   * The text actually embedded for this tag. Deliberately a short natural
   * phrase rather than the bare label: sentence encoders behave far better
   * on "a slow burn story that builds tension gradually" than on the two
   * words "slow burn", which are close to meaningless out of context.
   */
  phrase: string;
  /** Coarse genre fallback for titles with no embedding yet. May be empty. */
  genreIds: number[];
}

export const MOOD_VOCABULARY: MoodTag[] = [
  { id: "slow burn", phrase: "a slow burn story that builds tension gradually over time", genreIds: [GENRE.drama, GENRE.mystery] },
  { id: "fast paced", phrase: "a fast paced story with constant momentum and action", genreIds: [GENRE.action, GENRE.actionAdventure, GENRE.thriller] },
  { id: "unsettling", phrase: "an unsettling and disturbing story that leaves you uneasy", genreIds: [GENRE.horror, GENRE.thriller, GENRE.mystery] },
  { id: "atmospheric", phrase: "a moody atmospheric story driven by mood and setting", genreIds: [GENRE.drama, GENRE.mystery, GENRE.sciFiFantasy] },
  { id: "psychological", phrase: "a psychological story about the inner workings of the mind", genreIds: [GENRE.thriller, GENRE.drama, GENRE.mystery] },
  { id: "supernatural", phrase: "a supernatural story with ghosts demons or paranormal forces", genreIds: [GENRE.horror, GENRE.fantasy, GENRE.sciFiFantasy] },
  { id: "found footage", phrase: "a found footage story presented as recovered camera recordings", genreIds: [GENRE.horror] },
  { id: "jump scares", phrase: "a frightening story built on sudden shocks and jump scares", genreIds: [GENRE.horror] },
  { id: "comedic", phrase: "a funny lighthearted comedy that makes you laugh", genreIds: [GENRE.comedy] },
  { id: "dark", phrase: "a dark bleak story with a grim and pessimistic tone", genreIds: [GENRE.crime, GENRE.drama, GENRE.thriller] },
  { id: "feel good", phrase: "a warm uplifting feel good story with a hopeful ending", genreIds: [GENRE.comedy, GENRE.family, GENRE.romance] },
  { id: "twisty", phrase: "a twisty plot full of surprising revelations and reversals", genreIds: [GENRE.mystery, GENRE.thriller, GENRE.crime] },
  { id: "cerebral", phrase: "a cerebral thought provoking story about complex ideas", genreIds: [GENRE.sciFi, GENRE.sciFiFantasy, GENRE.drama] },
  { id: "emotional", phrase: "an emotional moving story about grief love and loss", genreIds: [GENRE.drama, GENRE.romance] },
  { id: "violent", phrase: "a brutal violent story with graphic bloodshed", genreIds: [GENRE.action, GENRE.crime, GENRE.horror] },
  { id: "true story", phrase: "a true story based on real events and real people", genreIds: [GENRE.documentary, GENRE.history] },
  { id: "mystery", phrase: "a mystery about uncovering the truth behind a crime or disappearance", genreIds: [GENRE.mystery, GENRE.crime] },
  { id: "epic", phrase: "an epic sweeping story on a grand scale across a vast world", genreIds: [GENRE.adventure, GENRE.actionAdventure, GENRE.fantasy, GENRE.sciFiFantasy] },
  { id: "cozy", phrase: "a gentle low stakes cozy story that is calming to watch", genreIds: [GENRE.comedy, GENRE.family] },
  { id: "satirical", phrase: "a sharp satirical story mocking politics power and society", genreIds: [GENRE.comedy, GENRE.warPolitics] },
  { id: "romantic", phrase: "a romantic story centred on falling in love", genreIds: [GENRE.romance] },
  { id: "gritty", phrase: "a gritty realistic story about crime on the street", genreIds: [GENRE.crime, GENRE.drama] },
  { id: "surreal", phrase: "a strange surreal dreamlike story that defies logic", genreIds: [GENRE.fantasy, GENRE.sciFiFantasy, GENRE.mystery] },
  { id: "nostalgic", phrase: "a nostalgic period story set in an earlier decade", genreIds: [GENRE.history, GENRE.drama] },
  { id: "bingeable", phrase: "an addictive bingeable story with cliffhanger endings", genreIds: [GENRE.drama, GENRE.thriller] },
  { id: "animated", phrase: "an animated story told through animation", genreIds: [GENRE.animation] },
  { id: "unscripted", phrase: "an unscripted reality show following real participants", genreIds: [GENRE.reality, GENRE.documentary] },
  { id: "western", phrase: "a western set in the american frontier", genreIds: [GENRE.western] },
  { id: "wartime", phrase: "a wartime story set during armed conflict", genreIds: [GENRE.war, GENRE.warPolitics] },
];

// ---- Tuning constants -------------------------------------------------------
//
// These are calibrated against measured output from all-MiniLM-L6-v2 (q8),
// not guessed. The measurements that set them, using real TMDB overviews:
//
//   query -> vocabulary tag (short text vs short text), best match:
//     "found footage"                -> found footage  0.63
//     "jump scares"                  -> jump scares    0.75
//     "funny and light"              -> comedic        0.58
//     "a documentary about a real disaster" -> true story 0.49,
//                                       but ALSO jump scares 0.45, found footage 0.44
//
//   query -> title overview (short text vs paragraph), same query across titles:
//     "something slow burn and unsettling" -> Paranormal Activity 0.21,
//         Chernobyl 0.16, Bake Off 0.13, Hereditary 0.10
//     "a documentary about a real disaster" -> Chernobyl 0.47, next best 0.25
//     "found footage"                      -> Paranormal Activity 0.27, next best 0.22
//
// Two things fall out of that, and both shaped the design rather than just
// the numbers:
//
// 1. Short-vs-short similarity is much higher than short-vs-paragraph. A
//    single threshold could never serve both, so tags and titles get
//    separate ones.
// 2. Title scores are not comparable ACROSS queries. The best match for one
//    query (0.47) outscores the best match for another (0.21) by more than
//    the gap between signal and noise within either. A fixed absolute cutoff
//    on title similarity therefore does not work: at 0.18 the "slow burn and
//    unsettling" query would have returned Bake Off and dropped Hereditary.
//    Titles are ranked relative to the best score for that same query
//    instead, with only a low absolute floor to discard true noise.

/**
 * Similarity above which a vocabulary tag counts as matched by the query.
 *
 * Set at 0.45 rather than lower because of the false positives measured
 * above: "a documentary about a real disaster" pulls "jump scares" to 0.45
 * and "found footage" to 0.44 purely on shared disaster/camera vocabulary.
 * Tags are shown to the user as the explanation for a result, so a wrong
 * tag actively misleads, which argues for precision over recall here.
 */
export const TAG_MATCH_THRESHOLD = 0.45;

/** Never surface more than this many matched tags, however many clear the bar. */
export const MAX_MATCHED_TAGS = 5;

/**
 * Absolute floor on title similarity. Deliberately low: its only job is to
 * discard titles with no relationship to the query at all, not to decide
 * what is a good match. TITLE_RELATIVE_FLOOR does that.
 */
export const TITLE_ABSOLUTE_FLOOR = 0.05;

/**
 * A title is kept when its similarity is at least this fraction of the best
 * similarity for the same query. Scale-free, so it behaves the same for a
 * query whose top match is 0.47 and one whose top match is 0.21.
 */
export const TITLE_RELATIVE_FLOOR = 0.45;

/**
 * Exclusion floor for a negated phrase, applied the same relative way.
 *
 * Both parts matter. The relative factor is high (0.85) because exclusion
 * should require being clearly the closest thing to what the user rejected,
 * not merely closer than average: wrongly hiding a title the user wanted is
 * a worse failure than leaving a near miss in the list. The absolute floor
 * is what stops "not found footage" from excluding the library's least
 * unrelated title when the library contains no found footage at all, since
 * the relative rule on its own always excludes something.
 */
export const NEGATION_RELATIVE_FACTOR = 0.85;
export const NEGATION_ABSOLUTE_FLOOR = 0.22;

/** Model identity, baked into cached vector keys so a model change invalidates them. */
export const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
/** Expected output width for the model above. Anything else is rejected as malformed. */
export const EMBEDDING_DIMENSIONS = 384;
