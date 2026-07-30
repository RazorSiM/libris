export interface OpdsLink {
  rel: string;
  href: string;
  type: string;
  title?: string;
}

export interface OpdsEntry {
  id: string;
  title: string;
  updated: string;
  author?: { name: string };
  summary?: string;
  links: OpdsLink[];
}

export interface OpdsFeed {
  id: string;
  title: string;
  updated: string;
  links: OpdsLink[];
  entries: OpdsEntry[];
  totalResults?: number;
  startIndex?: number;
  itemsPerPage?: number;
}
