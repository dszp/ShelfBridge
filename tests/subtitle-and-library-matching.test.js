import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateBookIdentificationScore } from '../src/matching/scoring/book-identification-scorer.js';
import { TitleAuthorMatcher } from '../src/matching/strategies/title-author-matcher.js';
import {
  extractTitle,
  extractTitleWithoutSubtitle,
} from '../src/matching/utils/audiobookshelf-extractor.js';

const atomicHabits = {
  media: {
    metadata: {
      title: 'Atomic Habits',
      subtitle: 'An Easy & Proven Way to Build Good Habits & Break Bad Ones',
      authors: [{ name: 'James Clear' }],
    },
  },
};
const atomicHabitsTitle = extractTitle(atomicHabits);

function makeCache() {
  return {
    generateTitleAuthorIdentifier(title, author) {
      return `title_author:${title}|${author}`;
    },
    async getCachedBookInfo() {
      return null;
    },
    async storeBookMatch() {},
  };
}

function makeClient(resultsByTitle = {}) {
  const searches = [];
  return {
    searches,
    async searchBooksForMatching(title, ...rest) {
      searches.push([title, ...rest]);
      return resultsByTitle[title] || [];
    },
    async getPreferredEditionFromBookId(bookId) {
      return {
        bookId,
        title: 'Catalog book',
        edition: { id: bookId * 10, reading_format: { format: 'Listened' } },
      };
    },
  };
}

function libraryEntry(userBookId, bookId, title, author) {
  return {
    id: userBookId,
    status_id: 2,
    book: {
      id: bookId,
      title,
      contributions: [{ author: { id: 1, name: author }, contribution: null }],
      editions: [
        {
          id: bookId * 10,
          asin: null,
          audio_seconds: 20000,
          reading_format: { format: 'Listened' },
        },
      ],
    },
  };
}

/** Lookup callbacks shaped like BookMatcher's, built from a library array */
function libraryLookups(library) {
  return [
    editionId =>
      library.find(ub => ub.book.editions.some(e => e.id === editionId)) ||
      null,
    bookId => library.find(ub => ub.book.id === bookId) || null,
    () => library,
  ];
}

describe('Subtitle-tolerant title scoring', () => {
  it('extracts the title with and without the subtitle', () => {
    assert.equal(
      atomicHabitsTitle,
      'Atomic Habits: An Easy & Proven Way to Build Good Habits & Break Bad Ones',
    );
    assert.equal(extractTitleWithoutSubtitle(atomicHabits), 'Atomic Habits');
    assert.equal(extractTitleWithoutSubtitle({ title: 'Plain' }), 'Plain');
    assert.equal(extractTitleWithoutSubtitle(null), null);
  });

  it('scores a catalog title that omits a real subtitle as a full title match', () => {
    const score = calculateBookIdentificationScore(
      { title: 'Atomic Habits', author_names: ['James Clear'] },
      atomicHabitsTitle,
      'James Clear',
      atomicHabits,
    );

    assert.equal(score.breakdown.title.score, 100);
    assert.equal(score.breakdown.title.matchedWithoutSubtitle, true);
    assert.ok(score.totalScore >= 70, `scored ${score.totalScore}`);
  });

  it('keeps the full-title score when the catalog title includes the subtitle', () => {
    const score = calculateBookIdentificationScore(
      { title: atomicHabitsTitle, author_names: ['James Clear'] },
      atomicHabitsTitle,
      'James Clear',
      atomicHabits,
    );

    assert.equal(score.breakdown.title.score, 100);
    assert.equal(score.breakdown.title.matchedWithoutSubtitle, false);
  });

  it('applies the short-title penalty to the bare title when it wins', () => {
    const dune = {
      media: {
        metadata: {
          title: 'Dune',
          subtitle: 'Deluxe Edition Illustrated',
          authors: [{ name: 'Frank Herbert' }],
        },
      },
    };
    const score = calculateBookIdentificationScore(
      { title: 'Dune', author_names: ['Frank Herbert'] },
      extractTitle(dune),
      'Frank Herbert',
      dune,
    );

    assert.equal(score.breakdown.title.matchedWithoutSubtitle, true);
    assert.equal(score.breakdown.shortTitlePenalty.score, -12);
  });

  it('retries the catalog search without the subtitle', async () => {
    const client = makeClient({
      'atomic habits': [
        {
          id: 7,
          title: 'Atomic Habits',
          author_names: ['James Clear'],
          users_count: 5000,
        },
      ],
    });
    const matcher = new TitleAuthorMatcher(client, makeCache(), {});

    const match = await matcher.findMatch(atomicHabits, 'test-user');

    assert.deepEqual(
      client.searches.map(s => s[0]),
      [
        'atomic habits an easy proven way to build good habits break bad ones',
        'atomic habits',
      ],
    );
    assert.equal(match.book.id, 7);
  });

  it('does not retry the search for a book without a subtitle', async () => {
    const client = makeClient();
    const matcher = new TitleAuthorMatcher(client, makeCache(), {});

    await matcher.findMatch(
      { title: 'Atomic Habits', author: 'James Clear' },
      'test-user',
    );

    assert.equal(client.searches.length, 1);
  });
});

describe('Matching against the user library first', () => {
  it('matches a book already in the library without searching the catalog', async () => {
    const library = [
      libraryEntry(18688168, 1616193, 'Atomic Habits', 'James Clear'),
      libraryEntry(2, 20, 'Project Hail Mary', 'Andy Weir'),
    ];
    const client = makeClient();
    const matcher = new TitleAuthorMatcher(client, makeCache(), {});

    const match = await matcher.findMatch(
      atomicHabits,
      'test-user',
      ...libraryLookups(library),
    );

    assert.equal(client.searches.length, 0);
    assert.equal(match.userBook.id, 18688168);
    assert.equal(match.book.id, 1616193);
    assert.equal(match._matchType, 'title_author_library');
    assert.equal(match._isSearchResult, false);
  });

  it('accepts a library match below the catalog threshold', async () => {
    // A small title difference with no year, series or activity data scores
    // below the 70% catalog threshold but above the 60% library threshold.
    const library = [
      libraryEntry(3, 30, 'The Theo of Golden Story', 'Allen Levi'),
    ];
    const client = makeClient();
    const matcher = new TitleAuthorMatcher(client, makeCache(), {});
    const absBook = { title: 'Theo of Golden', author: 'Allen Levi' };

    const score = calculateBookIdentificationScore(
      library[0].book,
      'Theo of Golden',
      'Allen Levi',
      absBook,
    ).totalScore;
    assert.ok(score >= 60 && score < 70, `scored ${score}`);

    const match = await matcher.findMatch(
      absBook,
      'test-user',
      ...libraryLookups(library),
    );

    assert.equal(client.searches.length, 0);
    assert.equal(match.userBook.id, 3);
  });

  it('falls back to the catalog when the library author differs', async () => {
    const library = [libraryEntry(4, 40, 'Atomic Habits', 'Someone Else')];
    const client = makeClient();
    const matcher = new TitleAuthorMatcher(client, makeCache(), {});

    await matcher.findMatch(
      atomicHabits,
      'test-user',
      ...libraryLookups(library),
    );

    assert.ok(client.searches.length > 0);
  });

  it('falls back to the catalog when two library books match equally well', async () => {
    const library = [
      libraryEntry(5, 50, 'Atomic Habits', 'James Clear'),
      libraryEntry(6, 60, 'Atomic Habits', 'James Clear'),
    ];
    const client = makeClient();
    const matcher = new TitleAuthorMatcher(client, makeCache(), {});

    await matcher.findMatch(
      atomicHabits,
      'test-user',
      ...libraryLookups(library),
    );

    assert.ok(client.searches.length > 0);
  });

  it('uses library_confidence_threshold from config', async () => {
    const library = [
      libraryEntry(3, 30, 'The Theo of Golden Story', 'Allen Levi'),
    ];
    const client = makeClient();
    const matcher = new TitleAuthorMatcher(client, makeCache(), {
      title_author_matching: { library_confidence_threshold: 0.9 },
    });

    await matcher.findMatch(
      { title: 'Theo of Golden', author: 'Allen Levi' },
      'test-user',
      ...libraryLookups(library),
    );

    assert.equal(client.searches.length, 1);
  });
});
