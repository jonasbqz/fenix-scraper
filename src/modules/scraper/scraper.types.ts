export interface ScrapedComic {
  id?: string;
  slug: string;
  title: string;
  titleAlternative?: string;
  description?: string;
  author?: string;
  artist?: string;
  coverImage?: string;
  type: 'manga' | 'manhwa' | 'manhua' | 'comic';
  status: 'ongoing' | 'completed' | 'hiatus' | 'cancelled';
  genres: string[];
  groupScan?: {
    /** Optional when only /grupos/<slug> was recovered from HTML. */
    name?: string;
    id?: string;
    slug?: string;
    cover?: string;
    url?: string;
  };
  firstChapterUrl?: string;
  lastChapterUrl?: string;
}

export interface ScrapedChapter {
  id?: string;
  chapterNumber: number;
  title?: string;
  slug: string;
  releaseDate?: Date;
  pages: string[];
  prevChapterUrl?: string;
  nextChapterUrl?: string;
}

export interface ChapterListItem {
  id: string;
  title: string;
  number: string;
  url: string;
  pathname: string;
  releaseDate?: Date;
}

export interface ScraperResult {
  comics: number;
  chapters: number;
  errors: string[];
}
