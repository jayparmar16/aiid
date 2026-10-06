import React, { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';

// The words the search reads as filters, grouped by what they do, each group with an example that
// parses as shown. The words stay untranslated, since the search reads them in English.
const groups = [
  {
    title: 'Leave out',
    words: ['excluding', 'except', 'but not', 'without'],
    example: 'crashes excluding tesla',
  },
  {
    title: 'Only these',
    words: ['by', 'from', 'involving', 'developed by', 'deployed by'],
    example: 'chatbots by openai',
  },
  {
    title: 'Who was harmed',
    words: ['affecting', 'harming', 'against'],
    example: 'errors affecting students',
  },
  {
    title: 'When',
    words: ['since', 'before', 'after', 'in', 'between'],
    example: 'deepfakes since 2023',
  },
];

/**
 * A slim tab on the right edge that opens a panel of the words the search understands. It slides
 * over the page, so it takes no room while closed, and it always starts closed. Using an example
 * hands its text to `onUseExample` and closes the panel without searching.
 */
export default function SearchWordsPanel({ onUseExample }) {
  const { t } = useTranslation();

  const [open, setOpen] = useState(false);

  const tabRef = useRef(null);

  const closeRef = useRef(null);

  // Whether closing hands focus back to the tab. Using an example leaves it to the search box.
  const returnFocus = useRef(true);

  const close = (focusTab = true) => {
    returnFocus.current = focusTab;
    setOpen(false);
  };

  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      closeRef.current?.focus();

      const closeOnEscape = (event) => {
        if (event.key === 'Escape') close();
      };

      document.addEventListener('keydown', closeOnEscape);

      wasOpen.current = true;

      return () => document.removeEventListener('keydown', closeOnEscape);
    }

    if (wasOpen.current && returnFocus.current) tabRef.current?.focus();
  }, [open]);

  const pickExample = (example) => {
    close(false);
    onUseExample(example);
  };

  return (
    <>
      <button
        ref={tabRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls="semantic-search-tips"
        className="fixed bottom-24 right-0 z-30 md:bottom-auto md:top-1/2 md:-translate-y-1/2 rounded-l-md border border-r-0 border-gray-300 bg-white px-1.5 py-3 text-xs text-gray-600 shadow-sm [writing-mode:vertical-rl] hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
        data-cy="semantic-search-tips-tab"
      >
        <Trans>Search tips</Trans>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/10"
          onClick={() => close()}
          aria-hidden="true"
          data-cy="semantic-search-tips-backdrop"
        />
      )}

      <aside
        id="semantic-search-tips"
        aria-labelledby="semantic-search-tips-title"
        className={`fixed right-0 top-0 z-50 h-full w-72 max-w-[85vw] overflow-y-auto border-l border-gray-200 bg-white p-5 shadow-lg transition-all duration-200 dark:border-gray-700 dark:bg-gray-900 ${
          open ? 'visible translate-x-0' : 'invisible translate-x-full'
        }`}
        data-cy="semantic-search-tips"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2
            id="semantic-search-tips-title"
            className="m-0 text-sm font-bold uppercase tracking-wider text-[rgb(59,69,78)] dark:text-gray-200"
          >
            <Trans>Search words</Trans>
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={() => close()}
            aria-label={t('Close search tips')}
            className="rounded p-1 text-gray-400 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            data-cy="semantic-search-tips-close"
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>

        {groups.map(({ title, words, example }) => (
          <section key={title} className="mb-4" data-cy="semantic-search-tips-group">
            <h3 className="m-0 mb-1 text-sm font-semibold text-gray-800 dark:text-gray-200">
              {t(title)}
            </h3>
            <p className="m-0 text-sm text-gray-600 dark:text-gray-400">{words.join(' · ')}</p>
            <p className="m-0 mt-1 text-xs text-gray-500">
              <Trans>e.g.</Trans>{' '}
              <button
                type="button"
                onClick={() => pickExample(example)}
                className="text-blue-700 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-blue-400"
                data-cy="semantic-search-tips-example"
              >
                {example}
              </button>
            </p>
          </section>
        ))}

        <p className="m-0 border-t border-gray-200 pt-3 text-xs text-gray-500 dark:border-gray-700">
          <Trans>Names must be spelled exactly, e.g. openai, not open ai.</Trans>
        </p>
      </aside>
    </>
  );
}
