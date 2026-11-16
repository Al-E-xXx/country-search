import type { CountryView } from '../api/map-country-response.js';
import type { SearchFailure, SearchFailureKind } from '../search/error-classification.js';

/**
 * Builds and updates everything the app shows.
 *
 * Nothing here talks to the network or decides when a search happens: the module
 * only turns one of the five states of a search into DOM nodes. Text is written
 * through `textContent` and every element is created explicitly, so a country
 * name or a server message can never be parsed as markup.
 *
 * The class names are the ones `src/styles.css` already styles; the two files are
 * meant to be read together.
 */

/** What the status panel looks like; the styling of each tone differs by more than colour. */
type StatusTone = 'idle' | 'loading' | 'empty' | 'error';

/**
 * What the interface may ask the app to do. The view never searches or clears by
 * itself: it reports the intent, and the wiring code decides what it means.
 */
export interface SearchViewActions {
  /** Fires on every keystroke, with whatever the box holds. */
  onQueryChange(query: string): void;
  /** Fires when the clear button is pressed. */
  onClearQuery(): void;
  /** Fires when the failure state is asked to search again. */
  onRetry(): void;
}

export interface SearchView {
  /** Neutral prompt shown before anything is searched, and after the input is emptied. */
  showIdle(): void;
  showLoading(query: string): void;
  showResults(countries: CountryView[], query: string): void;
  showNoMatches(query: string): void;
  showFailure(failure: SearchFailure, query: string): void;

  /** Puts `value` in the search box, keeping the clear button in step. */
  setQuery(value: string): void;
}

interface Shell {
  input: HTMLInputElement;
  clearButton: HTMLButtonElement;
  status: HTMLElement;
  results: HTMLUListElement;
}

const IDLE_MESSAGE = 'Start typing to search for a country.';
const NOT_REPORTED = 'not reported';
const QUOTE_OPEN = '\u201C';
const QUOTE_CLOSE = '\u201D';
const POPULATION_LABEL = 'Population';
const CAPITAL_LABEL = 'Capital';
const REGION_LABEL = 'Region';
const RETRY_LABEL = 'Try again';

const numberFormat = new Intl.NumberFormat('en-US');

/** Quotes a query in a message so the user sees exactly what was searched for. */
function quoted(query: string): string {
  return `${QUOTE_OPEN}${query}${QUOTE_CLOSE}`;
}

function formatCount(value: number): string {
  return numberFormat.format(value);
}

/** The line a failed search shows, chosen by what went wrong rather than by the error object. */
function failureMessage(kind: SearchFailureKind, status: number | null, query: string): string {
  switch (kind) {
    case 'http':
      // 404 never reaches this code: the transport turns it into an empty result.
      return `The country service answered ${status ?? 'an error'} for ${quoted(query)}.`;
    case 'timeout':
      return `The search for ${quoted(query)} took too long, so it was cancelled.`;
    case 'network':
      return `The country service could not be reached while searching for ${quoted(query)}.`;
    case 'unknown':
      return `The search for ${quoted(query)} failed for an unexpected reason.`;
  }
}

function textElement(className: string, text: string): HTMLElement {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

/** Flag picture with an emoji stand-in, used by the cards and the details panel alike. */
function emojiFlag(country: CountryView, baseClass: string): HTMLElement {
  const flag = document.createElement('span');
  flag.className = `${baseClass} ${baseClass}--emoji`;
  flag.textContent = country.flagEmoji ?? '?';
  flag.setAttribute('role', 'img');
  flag.setAttribute('aria-label', `Flag of ${country.name}`);
  return flag;
}

/** Only an ordinary http(s) picture goes into `img.src`; anything else falls back to the emoji. */
function isSafeImageUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function createFlag(country: CountryView, baseClass: string): HTMLElement {
  if (country.flagUrl === null || !isSafeImageUrl(country.flagUrl)) {
    return emojiFlag(country, baseClass);
  }

  const image = document.createElement('img');
  image.className = baseClass;
  image.src = country.flagUrl;
  image.alt = `Flag of ${country.name}`;
  image.loading = 'lazy';
  // A flag host that is unreachable shows the emoji instead of a broken picture.
  image.addEventListener(
    'error',
    () => {
      image.replaceWith(emojiFlag(country, baseClass));
    },
    { once: true },
  );
  return image;
}

/** Joins the parts of a line, leaving out the ones the endpoint did not report. */
function joinParts(parts: (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(' · ');
}

function cardMeta(country: CountryView): string {
  const capital = country.capital === null ? null : `${CAPITAL_LABEL}: ${country.capital}`;
  const region = country.region === null ? null : `${REGION_LABEL}: ${country.region}`;
  return joinParts([capital, region]);
}

/** One result: a button, because selecting a country is what clicking it does. */
function createCountryCard(country: CountryView): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'country-card';

  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'country-card__select';
  select.setAttribute('aria-label', `Show details for ${country.name}`);

  select.append(createFlag(country, 'country-card__flag'));

  const body = document.createElement('span');
  body.className = 'country-card__body';
  body.append(textElement('country-card__name', country.name));

  const meta = cardMeta(country);
  if (meta !== '') {
    body.append(textElement('country-card__meta', meta));
  }

  const population =
    country.population === null
      ? `${POPULATION_LABEL}: ${NOT_REPORTED}`
      : `${POPULATION_LABEL}: ${formatCount(country.population)}`;
  body.append(textElement('country-card__population', population));

  select.append(body);
  item.append(select);
  return item;
}

/** The part of the page the app owns: search box, status panel, results. */
function buildShell(mount: HTMLElement): Shell {
  const app = document.createElement('div');
  app.className = 'app';

  const header = document.createElement('header');
  header.className = 'app__header';
  const title = document.createElement('h1');
  title.className = 'app__title';
  title.textContent = 'Country search';
  const hint = document.createElement('p');
  hint.className = 'app__hint';
  hint.textContent = 'Results follow what you type, one search at a time.';
  header.append(title, hint);

  const search = document.createElement('div');
  search.className = 'search';

  const input = document.createElement('input');
  input.className = 'search__input';
  input.type = 'search';
  input.placeholder = 'Country name, for example “spain”';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Search for a country');

  const clearButton = document.createElement('button');
  clearButton.type = 'button';
  clearButton.className = 'search__clear';
  clearButton.textContent = 'Clear';
  clearButton.hidden = true;

  search.append(input, clearButton);

  const status = document.createElement('output');
  status.className = 'status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const layout = document.createElement('div');
  layout.className = 'layout';

  const results = document.createElement('ul');
  results.className = 'country-list';

  layout.append(results);

  app.append(header, search, status, layout);
  mount.append(app);

  return { input, clearButton, status, results };
}

/**
 * Marks the results as belonging to another query: the styles dim them, so they
 * cannot be read as the answer to the text in the box. The list itself stays on
 * screen — clearing it on every keystroke would make the page flicker.
 */
function markResultsStale(shell: Shell, isStale: boolean): void {
  if (isStale) {
    shell.results.dataset.stale = 'true';
  } else {
    delete shell.results.dataset.stale;
  }
}

/**
 * Shows the one message of the current search and repaints the panel in the tone
 * that belongs to it. The panel carries a `data-tone` attribute, which is what
 * the styles use to pick colour, border and icon.
 */
function renderStatus(shell: Shell, tone: StatusTone, message: string): void {
  const { status } = shell;

  status.dataset.tone = tone;
  status.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  status.replaceChildren();

  if (tone === 'loading') {
    const spinner = document.createElement('span');
    spinner.className = 'status__spinner';
    spinner.setAttribute('aria-hidden', 'true');
    status.append(spinner);
  }

  status.append(textElement('status__text', message));
  status.hidden = false;
}

/**
 * Creates the interface inside `mount`. The view attaches its own listeners: the
 * search box, the clear button and the retry button of the failure state, which
 * is rebuilt on every failure and therefore cannot be wired from the outside.
 */
export function createSearchView(mount: HTMLElement, actions: SearchViewActions): SearchView {
  const shell = buildShell(mount);
  /** The query the results on screen are the answer to; `null` when there are none. */
  let resultsQuery: string | null = null;

  /**
   * Keeps the stale marking in step with the search box. The results answer
   * `resultsQuery`, so they stop being current as soon as the text differs — which
   * happens while the debounce is still waiting, before a new request exists.
   */
  const syncStaleMarking = (): void => {
    const current = shell.input.value.trim();
    markResultsStale(shell, resultsQuery !== null && resultsQuery !== current);
  };

  const clearResults = (): void => {
    shell.results.replaceChildren();
    shell.results.hidden = true;
    resultsQuery = null;
    markResultsStale(shell, false);
  };

  const showIdle = (): void => {
    renderStatus(shell, 'idle', IDLE_MESSAGE);
    clearResults();
  };

  const showLoading = (query: string): void => {
    renderStatus(shell, 'loading', `Searching for ${quoted(query)}\u2026`);
    // The results of the previous query stay on screen while this search is in
    // flight: they are not wrong yet, and clearing them would make the list
    // flicker on every keystroke. They are only marked as another query's answer.
    syncStaleMarking();
  };

  const showResults = (countries: CountryView[], query: string): void => {
    const kind = countries.length === 1 ? 'country' : 'countries';
    renderStatus(shell, 'idle', `${countries.length} ${kind} for ${quoted(query)}`);
    shell.results.replaceChildren(...countries.map(createCountryCard));
    shell.results.hidden = false;
    resultsQuery = query;
    syncStaleMarking();
  };

  const showNoMatches = (query: string): void => {
    renderStatus(shell, 'empty', `No country matches ${quoted(query)}. Try another spelling.`);
    clearResults();
  };

  const showFailure = (failure: SearchFailure, query: string): void => {
    renderStatus(shell, 'error', failureMessage(failure.kind, failure.status, query));
    clearResults();

    // A retry is offered only when the same request could plausibly work.
    if (failure.retryable) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'status__action';
      button.textContent = RETRY_LABEL;
      button.addEventListener('click', actions.onRetry);
      shell.status.append(button);
    }
  };

  /** The clear button only makes sense while there is something to clear. */
  const syncClearButton = (value: string): void => {
    shell.clearButton.hidden = value === '';
  };

  const setQuery = (value: string): void => {
    shell.input.value = value;
    syncClearButton(value);
    syncStaleMarking();
  };

  shell.input.addEventListener('input', () => {
    // The box already holds what was typed, so only the clear button and the stale
    // marking are out of date — for example after the native "clear" affordance of
    // a `type="search"` box, which changes the value without this app's help.
    syncClearButton(shell.input.value);
    syncStaleMarking();
    actions.onQueryChange(shell.input.value);
  });
  shell.clearButton.addEventListener('click', () => {
    setQuery('');
    actions.onClearQuery();
  });

  return {
    showIdle,
    showLoading,
    showResults,
    showNoMatches,
    showFailure,
    setQuery,
  };
}
