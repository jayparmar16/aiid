import React, { useEffect, useState } from 'react';
import { gql, useApolloClient } from '@apollo/client';
import debounce from 'lodash/debounce';
import RelatedIncidentsArea from './RelatedIncidentsArea';
import { stripMarkdown } from '../utils/typography';
import { buildIncidentOverview } from '../utils/embeddings/incidentText';
import { useTranslation } from 'react-i18next';

const relatedIncidentIdsQuery = gql`
  query ProbablyRelatedIncidentIds($filter: IncidentFilterType) {
    incidents(filter: $filter) {
      incident_id
      title
    }
  }
`;

const SemanticallyRelatedIncidents = ({
  incident,
  setFieldValue,
  editId = true,
  useIncidentOverview = false,
  excludeIncidentId,
}) => {
  const { t } = useTranslation();

  const [loading, setLoading] = useState(false);

  const [incidents, setIncidents] = useState([]);

  const [error, setError] = useState(null);

  const client = useApolloClient();

  const usingOverview = useIncidentOverview && !incident?.text?.trim();

  const text = usingOverview ? buildIncidentOverview(incident || {}) : incident?.text || '';

  useEffect(() => {
    const controller = new AbortController();

    let active = true;

    let timer;

    setIncidents([]);
    setError(null);
    setLoading(Boolean(text.trim()));
    if (setFieldValue) setFieldValue('nlp_similar_incidents', []);

    const update = debounce(async () => {
      let errorMessage = t('Could not compute semantic similarity');

      try {
        const plaintext = await stripMarkdown(text);

        if (!active) return;
        const minLength = 256;

        if (!usingOverview && plaintext.replace(/\s/g, '').length < minLength) {
          setError(
            t(
              'Reports must have at least {{minLength}} non-space characters to compute semantic similarity.',
              { minLength }
            )
          );
          return;
        }

        timer = setTimeout(() => controller.abort(), 66000);
        const response = await fetch('/api/semanticallyRelated', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: plaintext, excludeIncidentId }),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error('Semantic relation error');
        const result = await response.json();

        if (!active) return;
        const related = [...result.incidents].sort(
          (left, right) => right.similarity - left.similarity
        );

        const ids = related.map((item) => item.incident_id);

        if (ids.length === 0) return;
        errorMessage = t('Could not retrieve related incidents from database');
        const { data } = await client.query({
          query: relatedIncidentIdsQuery,
          variables: { filter: { incident_id: { IN: ids } } },
          context: { fetchOptions: { signal: controller.signal } },
        });

        if (!active) return;
        const byId = new Map(data.incidents.map((item) => [item.incident_id, item]));

        const found = related.filter((item) => byId.has(item.incident_id));

        setIncidents(found.map((item) => byId.get(item.incident_id)));
        if (setFieldValue) setFieldValue('nlp_similar_incidents', found);
      } catch (requestError) {
        if (!active) return;
        console.error(requestError);
        setError(errorMessage);
      } finally {
        clearTimeout(timer);
        if (active) setLoading(false);
      }
    }, 2000);

    if (text.trim()) update();
    return () => {
      active = false;
      update.cancel();
      controller.abort();
      clearTimeout(timer);
    };
  }, [text, usingOverview, excludeIncidentId, client, setFieldValue, t]);

  return (
    <div data-cy="semantically-related-incidents" className="flex">
      {text.trim().length > 0 && (
        <RelatedIncidentsArea
          key="byText"
          columnKey="byText"
          loading={loading}
          incidents={incidents}
          header={t('Most Semantically Similar Incidents (Experimental)')}
          setFieldValue={setFieldValue}
          editId={editId}
          error={error}
        />
      )}
    </div>
  );
};

export default SemanticallyRelatedIncidents;
