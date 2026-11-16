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

  /**
   * Takes back the message of a search whose query the box no longer matches,
   * together with the retry control that came with it. The flow reports a new
   * state only once its debounce has passed, so for a moment the old message is
   * the only thing on screen that can still be pressed.
   */
  clearFeedbackFor(query: string): void;

  /** Puts `value` in the search box, keeping the clear button in step. */
  setQuery(value: string): void;
}

interface Shell {
  input: HTMLInputElement;
  clearButton: HTMLButtonElement;
  status: HTMLElement;
  results: HTMLUListElement;
  details: HTMLElement;
}

const IDLE_MESSAGE = 'Start typing to search for a country.';
const NOT_REPORTED = 'not reported';
const QUOTE_OPEN = '\u201C';
const QUOTE_CLOSE = '\u201D';
const POPULATION_LABEL = 'Population';
const CAPITAL_LABEL = 'Capital';
const REGION_LABEL = 'Region';
const AREA_LABEL = 'Area';
const AREA_UNIT = 'km²';
const LANGUAGES_LABEL = 'Languages';
const CURRENCIES_LABEL = 'Currencies';
const BORDERS_LABEL = 'Bordering countries';
const RETRY_LABEL = 'Try again';
const CLOSE_LABEL = 'Close';
const LIST_SEPARATOR = ', ';
/** The details panel is one element reused for every country, so a card can name it. */
const DETAILS_PANEL_ID = 'country-details';

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
function createCountryCard(
  country: CountryView,
  onSelect: (country: CountryView, card: HTMLButtonElement) => void,
): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'country-card';

  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'country-card__select';
  select.setAttribute('aria-label', `Show details for ${country.name}`);
  select.setAttribute('aria-expanded', 'false');
  select.setAttribute('aria-controls', DETAILS_PANEL_ID);

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

  select.addEventListener('click', () => {
    onSelect(country, select);
  });

  return item;
}

function countOrNotReported(value: number | null): string {
  return value === null ? NOT_REPORTED : formatCount(value);
}

function listOrNotReported(items: string[]): string {
  return items.length === 0 ? NOT_REPORTED : items.join(LIST_SEPARATOR);
}

/**
 * What a details row says about a country. A value the endpoint did not report is
 * spelled out rather than left out, so a blank never looks like a bug. `borders`
 * holds alpha-3 codes: the search endpoint gives no names for them, and inventing
 * a second request per border is not worth a prettier list.
 */
function detailsFacts(country: CountryView): Array<[string, string]> {
  const area = country.area === null ? null : `${formatCount(country.area)} ${AREA_UNIT}`;
  return [
    [CAPITAL_LABEL, country.capital ?? NOT_REPORTED],
    [POPULATION_LABEL, countOrNotReported(country.population)],
    [AREA_LABEL, area ?? NOT_REPORTED],
    [LANGUAGES_LABEL, listOrNotReported(country.languages)],
    [CURRENCIES_LABEL, listOrNotReported(country.currencies)],
    [BORDERS_LABEL, listOrNotReported(country.borders)],
  ];
}

/** The line under the country name: who its people are and where it sits. */
function detailsSummary(country: CountryView): string {
  return joinParts([country.demonym, country.region, country.subregion]);
}

/**
 * Builds the details of one country. The panel is rebuilt on every selection — the
 * same reason the retry button is: an element that is thrown away each time cannot
 * be wired from the outside.
 */
function createDetailsNodes(country: CountryView, onClose: () => void): HTMLElement[] {
  const header = document.createElement('div');
  header.className = 'details__header';
  header.append(createFlag(country, 'details__flag'));

  const titles = document.createElement('div');
  titles.className = 'details__titles';
  const name = document.createElement('h2');
  name.className = 'details__name';
  name.textContent = country.name;
  titles.append(name);
  if (country.nativeName !== null) {
    const nativeName = document.createElement('p');
    nativeName.className = 'details__native-name';
    nativeName.textContent = country.nativeName;
    titles.append(nativeName);
  }
  header.append(titles);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'details__close';
  close.textContent = CLOSE_LABEL;
  close.setAttribute('aria-label', `Close details for ${country.name}`);
  close.addEventListener('click', onClose);
  header.append(close);

  const nodes: HTMLElement[] = [header];

  const summaryText = detailsSummary(country);
  if (summaryText !== '') {
    const summary = document.createElement('p');
    summary.className = 'details__summary';
    summary.textContent = summaryText;
    nodes.push(summary);
  }

  const facts = document.createElement('dl');
  facts.className = 'details__facts';
  for (const [label, value] of detailsFacts(country)) {
    const row = document.createElement('div');
    row.className = 'details__fact';

    const term = document.createElement('dt');
    term.textContent = label;

    const description = document.createElement('dd');
    description.textContent = value;

    row.append(term, description);
    facts.append(row);
  }
  nodes.push(facts);

  return nodes;
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

  const details = document.createElement('aside');
  details.className = 'details';
  details.setAttribute('id', DETAILS_PANEL_ID);
  details.setAttribute('aria-label', 'Country details');
  details.hidden = true;

  layout.append(results, details);

  app.append(header, search, status, layout);
  mount.append(app);

  return { input, clearButton, status, results, details };
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
 * search box, the clear button, the cards, the details close button and the retry
 * button of the failure state. All of those are rebuilt as the search moves on, so
 * nobody outside could keep hold of them; what the view reports to the app is only
 * the intent behind a press.
 */
export function createSearchView(mount: HTMLElement, actions: SearchViewActions): SearchView {
  const shell = buildShell(mount);
  /** The query the results on screen are the answer to; `null` when there are none. */
  let resultsQuery: string | null = null;
  /** The card whose details are open. Only one country is ever selected. */
  let selectedCard: HTMLButtonElement | null = null;

  /**
   * Closes the details panel. It can be asked for by the panel's own button, by
   * pressing the same card again, by Escape, or by a new set of results — which is
   * why the code lives in one place instead of in the button.
   */
  const closeDetails = (): void => {
    if (selectedCard !== null) {
      delete selectedCard.dataset.selected;
      selectedCard.setAttribute('aria-expanded', 'false');
      selectedCard = null;
    }
    shell.details.hidden = true;
    shell.details.replaceChildren();
  };

  /**
   * Shows one country's details. A card is a toggle: pressing the one that is
   * already open closes the panel again, and `aria-expanded` on the card tells
   * assistive technology which of the two the next press will do.
   */
  const openDetails = (country: CountryView, card: HTMLButtonElement): void => {
    const isAlreadyOpen = selectedCard === card;
    closeDetails();
    if (isAlreadyOpen) {
      return;
    }

    shell.details.replaceChildren(...createDetailsNodes(country, closeDetails));
    shell.details.hidden = false;
    selectedCard = card;
    card.dataset.selected = 'true';
    card.setAttribute('aria-expanded', 'true');
  };

  /**
   * Keeps the stale marking in step with the search box. The results answer
   * `resultsQuery`, so they stop being current as soon as the text differs — which
   * happens while the debounce is still waiting, before a new request exists.
   */
  const syncStaleMarking = (): void => {
    const current = shell.input.value.trim();
    markResultsStale(shell, resultsQuery !== null && resultsQuery !== current);
  };

  /** The query the feedback on screen was written for, or `null` when there is none. */
  let feedbackQuery: string | null = null;

  const clearResults = (): void => {
    // Details belong to a card of this list, so they leave with the list.
    closeDetails();
    shell.results.replaceChildren();
    shell.results.hidden = true;
    resultsQuery = null;
    markResultsStale(shell, false);
  };

  const showIdle = (): void => {
    renderStatus(shell, 'idle', IDLE_MESSAGE);
    feedbackQuery = null;
    clearResults();
  };

  const showLoading = (query: string): void => {
    renderStatus(shell, 'loading', `Searching for ${quoted(query)}\u2026`);
    // The message of a failed or empty search is replaced by this one, so the
    // retry control that came with it is gone as well.
    feedbackQuery = null;
    // The results of the previous query stay on screen while this search is in
    // flight: they are not wrong yet, and clearing them would make the list
    // flicker on every keystroke. They are only marked as another query's answer.
    syncStaleMarking();
  };

  const showResults = (countries: CountryView[], query: string): void => {
    const kind = countries.length === 1 ? 'country' : 'countries';
    renderStatus(shell, 'idle', `${countries.length} ${kind} for ${quoted(query)}`);
    feedbackQuery = null;
    // Any details on screen belong to cards that are about to be thrown away.
    closeDetails();
    shell.results.replaceChildren(
      ...countries.map((country) => createCountryCard(country, openDetails)),
    );
    shell.results.hidden = false;
    resultsQuery = query;
    syncStaleMarking();
  };

  const showNoMatches = (query: string): void => {
    renderStatus(shell, 'empty', `No country matches ${quoted(query)}. Try another spelling.`);
    feedbackQuery = query.trim();
    clearResults();
  };

  const showFailure = (failure: SearchFailure, query: string): void => {
    renderStatus(shell, 'error', failureMessage(failure.kind, failure.status, query));
    feedbackQuery = query.trim();
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

  /**
   * Takes back an empty or failed message — and with it the retry control — as
   * soon as the box holds another query than the one they were written for. The
   * flow answers a new query only after its debounce, so until then the old
   * message is what the user sees, and pressing its retry would start a request
   * out of step with that debounce.
   */
  const clearFeedbackFor = (query: string): void => {
    if (feedbackQuery === null || feedbackQuery === query) {
      return;
    }

    feedbackQuery = null;
    shell.status.hidden = true;
    shell.status.replaceChildren();
  };

  /** The clear button only makes sense while there is something to clear. */
  const syncClearButton = (value: string): void => {
    shell.clearButton.hidden = value === '';
  };

  const setQuery = (value: string): void => {
    shell.input.value = value;
    syncClearButton(value);
    syncStaleMarking();
    clearFeedbackFor(value.trim());
  };

  shell.input.addEventListener('input', () => {
    // The box already holds what was typed, so only the clear button and the stale
    // marking are out of date — for example after the native "clear" affordance of
    // a `type="search"` box, which changes the value without this app's help.
    syncClearButton(shell.input.value);
    syncStaleMarking();
    clearFeedbackFor(shell.input.value.trim());
    actions.onQueryChange(shell.input.value);
  });
  shell.clearButton.addEventListener('click', () => {
    setQuery('');
    actions.onClearQuery();
  });

  // Escape closes the details. Focus can be on a card or inside the panel, so the
  // key is watched on both containers; nothing else on the page reacts to it.
  const closeDetailsOnEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      closeDetails();
    }
  };
  shell.results.addEventListener('keydown', closeDetailsOnEscape);
  shell.details.addEventListener('keydown', closeDetailsOnEscape);

  return {
    showIdle,
    showLoading,
    showResults,
    showNoMatches,
    showFailure,
    clearFeedbackFor,
    setQuery,
  };
}
