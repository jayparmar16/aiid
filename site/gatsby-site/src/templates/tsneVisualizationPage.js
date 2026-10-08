import React from 'react';
import HeadContent from 'components/HeadContent';
import TsneVisualization from 'components/cite/TsneVisualization';
import { Trans, useTranslation } from 'react-i18next';

function TsneVisulizationPage(props) {
  const { t } = useTranslation();

  const spatialIncidents = props.pageContext.spatialIncidents;

  const classifications = props.pageContext.classifications;

  const taxa = props.pageContext.taxa;

  const csetClassifications = props.pageContext.csetClassifications;

  const metaDescription = t('Spatial Visualization');

  return (
    <div className="max-w-full w-full" {...props}>
      <div className={'titleWrapper'}>
        <h1>{t(metaDescription)}</h1>
      </div>

      {spatialIncidents.length > 0 ? (
        <TsneVisualization
          currentIncidentId={Number(
            typeof window !== 'undefined'
              ? new URLSearchParams(window.location.search).get('incident') || -1
              : -1
          )}
          incidents={spatialIncidents}
          {...{
            classifications,
            taxa,
            csetClassifications,
          }}
        />
      ) : (
        <p data-cy="spatial-empty">
          <Trans>
            No incidents with compatible overview embeddings are available for the spatial view yet.
          </Trans>
        </p>
      )}
      <p className="mt-4" style={{ maxWidth: '1000px' }}>
        <Trans i18nKey="tsneOverviewDescription">
          The spatial view plots incidents with compatible overview embeddings. Positions are
          computed from incident titles and descriptions, so incidents with similar overviews tend
          to appear closer together. This is a two-dimensional t-SNE projection, not an exact
          similarity score.
        </Trans>
      </p>
    </div>
  );
}

export const Head = (props) => {
  const {
    location: { pathname },
  } = props;

  const { t } = useTranslation();

  const metaTitle = t('Spatial Visualization');

  const metaDescription = t('Spatial Visualization');

  return <HeadContent path={pathname} {...{ metaTitle, metaDescription }} metaType="website" />;
};

export default TsneVisulizationPage;
