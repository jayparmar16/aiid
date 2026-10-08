import { ApolloServer } from '@apollo/server';
import { ObjectId } from 'bson';
import { hasRelevantUpdates } from '../fields/common';
import { getCollection, makeRequest, mockSession, seedFixture, startTestServer } from './utils';

const submissionId = new ObjectId('5f8f4b3b9b3e6f001f3b3b3b');
const incidentEmbedding = { vector: [1, 0], from_reports: [1] };
const reportEmbedding = { vector: [0, 1, 0], from_text_hash: 'frozen' };
const oldIncidentEmbedding = { vector: [9, 9], from_reports: [999] };
const oldReportEmbedding = { vector: [9, 9], from_text_hash: 'old' };
const incident = {
  incident_id: 1,
  title: 'Current incident',
  description: 'Current description',
  date: '2020-01-01',
  editor_notes: '',
  editors: [],
  reports: [1],
  flagged_dissimilar_incidents: [],
  'Alleged deployer of AI system': [],
  'Alleged developer of AI system': [],
  'Alleged harmed or nearly harmed parties': [],
  implicated_systems: [],
  embedding: incidentEmbedding,
};
const article = {
  title: 'Current article',
  text: 'Current text',
  plain_text: 'Current text',
  description: 'Current description',
  authors: [],
  submitters: [],
  tags: [],
  cloudinary_id: '',
  image_url: '',
  language: 'en',
  url: 'https://example.test/article',
  source_domain: 'example.test',
  date_downloaded: '2020-01-01T00:00:00.000Z',
  date_modified: '2020-01-01T00:00:00.000Z',
  date_published: '2020-01-01T00:00:00.000Z',
  date_submitted: '2020-01-01T00:00:00.000Z',
};
const schemaV2Record = {
  incident_id: 1,
  embedding_schema_version: 2,
  source_hash: 'awaiting-refresh',
};

describe('Legacy embedding retirement', () => {
  let server: ApolloServer, url: string;

  beforeAll(async () => {
    ({ server, url } = await startTestServer());
  });

  afterAll(async () => {
    await server?.stop();
  });

  beforeEach(async () => {
    await seedFixture({
      customData: { users: [{ userId: 'editor', roles: ['incident_editor'] }], notifications: [] },
      aiidprod: {
        incidents: [
          { ...incident },
          {
            ...incident,
            incident_id: 2,
            reports: [],
            embedding: { vector: [0, 1], from_reports: [] },
          },
        ],
        reports: [
          {
            ...article,
            report_number: 1,
            epoch_date_published: 1577836800,
            epoch_date_submitted: 1577836800,
            embedding: reportEmbedding,
          },
        ],
        submissions: [
          {
            ...article,
            _id: submissionId,
            incident_date: '2020-01-01',
            user: 'editor',
            embedding: reportEmbedding,
          },
        ],
        incident_embeddings: [{ ...schemaV2Record }],
        entities: [],
      },
      history: {
        incidents: [{ ...incident, title: 'Old incident', embedding: oldIncidentEmbedding }],
        reports: [
          {
            report_number: 1,
            title: 'Old article',
            text: 'Old text',
            embedding: oldReportEmbedding,
          },
        ],
      },
    });
    mockSession('editor');
  });

  const request = async (query: string, variables?: Record<string, unknown>) => {
    const response = await makeRequest(url, { query, variables });
    expect(response.body.errors).toBeUndefined();
    return response.body.data;
  };

  const expectPipelineUntouched = async () => {
    expect(
      await getCollection('aiidprod', 'incident_embeddings').find().project({ _id: 0 }).toArray()
    ).toEqual([schemaV2Record]);
  };

  it('relinks and unlinks reports without averaging or removing frozen vectors', async () => {
    // Deliberately mismatched legacy dimensions must never enter similarity math.
    for (const incident_ids of [[2], []]) {
      await request(
        `mutation ($input: LinkReportsToIncidentsInput!) {
        linkReportsToIncidents(input: $input) { incident_id }
      }`,
        { input: { incident_ids, report_numbers: [1] } }
      );
      expect(
        await getCollection('aiidprod', 'incidents').findOne({ incident_id: 1 })
      ).toMatchObject({ reports: [], embedding: incidentEmbedding });
      expect(
        await getCollection('aiidprod', 'incidents').findOne({ incident_id: 2 })
      ).toMatchObject({
        reports: incident_ids.length ? [1] : [],
        embedding: { vector: [0, 1], from_reports: [] },
      });
      expect(
        await getCollection('aiidprod', 'reports').findOne({ report_number: 1 })
      ).toMatchObject({ embedding: reportEmbedding, is_incident_report: incident_ids.length > 0 });
    }
    await expectPipelineUntouched();
  });

  it.each([true, false])(
    'promotes to an existing incident with submission embedding present=%s',
    async (withEmbedding) => {
      if (!withEmbedding)
        await getCollection('aiidprod', 'submissions').updateOne(
          { _id: submissionId },
          { $unset: { embedding: '' } }
        );
      await request(
        `mutation ($input: PromoteSubmissionToReportInput!) {
      promoteSubmissionToReport(input: $input) { incident_ids report_number }
    }`,
        {
          input: {
            submission_id: submissionId.toHexString(),
            is_incident_report: true,
            incident_ids: [1],
          },
        }
      );
      expect(
        await getCollection('aiidprod', 'incidents').findOne({ incident_id: 1 })
      ).toMatchObject({ reports: [1, 2], embedding: incidentEmbedding });
      expect(
        await getCollection('aiidprod', 'reports').findOne({ report_number: 2 })
      ).not.toHaveProperty('embedding');
      expect(
        await getCollection('history', 'reports').findOne({ report_number: 2 })
      ).not.toHaveProperty('embedding');
      expect(
        await getCollection('history', 'incidents').findOne({ incident_id: 1, reports: 2 })
      ).toMatchObject({ embedding: incidentEmbedding, modifiedBy: 'editor' });
      expect(await getCollection('aiidprod', 'submissions').countDocuments()).toBe(0);
      await expectPipelineUntouched();
    }
  );

  it.each([true, false])(
    'promotes a legacy submission to a new incident=%s without copying its vector',
    async (is_incident_report) => {
      const result = await request(
        `mutation ($input: PromoteSubmissionToReportInput!) {
      promoteSubmissionToReport(input: $input) { incident_ids report_number }
    }`,
        {
          input: {
            submission_id: submissionId.toHexString(),
            is_incident_report,
            incident_ids: [],
          },
        }
      );
      expect(result.promoteSubmissionToReport).toEqual({
        incident_ids: is_incident_report ? [3] : [],
        report_number: 2,
      });
      expect(
        await getCollection('aiidprod', 'reports').findOne({ report_number: 2 })
      ).not.toHaveProperty('embedding');
      expect(
        await getCollection('history', 'reports').findOne({ report_number: 2 })
      ).not.toHaveProperty('embedding');
      if (is_incident_report) {
        const created = await getCollection('aiidprod', 'incidents').findOne({ incident_id: 3 });
        expect(created).toMatchObject({ reports: [2], title: article.title });
        expect(created).not.toHaveProperty('embedding');
        const snapshot = await getCollection('history', 'incidents').findOne({ incident_id: 3 });
        expect(snapshot).toMatchObject({ reports: [2], modifiedBy: 'editor' });
        expect(snapshot).not.toHaveProperty('embedding');
        expect(
          await getCollection('customData', 'notifications').countDocuments({ incident_id: 3 })
        ).toBe(3);
      }
      await expectPipelineUntouched();
    }
  );

  it.each([
    ['Incident', 'incidents', { incident_id: { EQ: 1 } }, incidentEmbedding, oldIncidentEmbedding],
    ['Report', 'reports', { report_number: { EQ: 1 } }, reportEmbedding, oldReportEmbedding],
    [
      'Submission',
      'submissions',
      { _id: { EQ: submissionId.toHexString() } },
      reportEmbedding,
      oldReportEmbedding,
    ],
  ] as const)(
    'ignores restored vectors for %s while saving content and keeping historical reads',
    async (type, collection, filter, frozen, older) => {
      const result = await request(
        `mutation ($filter: ${type}FilterType!, $update: ${type}UpdateType!) {
      updateOne${type}(filter: $filter, update: $update) { title embedding { vector } }
    }`,
        { filter, update: { set: { title: 'Restored title', embedding: older } } }
      );
      expect(result[`updateOne${type}`]).toEqual({
        title: 'Restored title',
        embedding: { vector: [...frozen.vector] },
      });
      expect(
        await getCollection('aiidprod', collection).findOne({ title: 'Restored title' })
      ).toMatchObject({ embedding: frozen });
      if (type === 'Incident' || type === 'Report') {
        const history = await request(
          `query { history_${collection} { title embedding { vector } } }`
        );
        expect(history[`history_${collection}`]).toContainEqual({
          title: type === 'Incident' ? 'Old incident' : 'Old article',
          embedding: { vector: [...older.vector] },
        });
      }
      await expectPipelineUntouched();
    }
  );

  it.each([
    ['Incident', { incident_id: { EQ: 1 } }, incidentEmbedding, 'from_reports'],
    ['Report', { report_number: { EQ: 1 } }, reportEmbedding, 'from_text_hash'],
    ['Submission', { _id: { EQ: submissionId.toHexString() } }, reportEmbedding, 'from_text_hash'],
  ] as const)(
    'treats legacy-only writes to %s as no-ops, including null and flattened partial paths',
    async (type, filter, frozen, hashField) => {
      for (const embedding of [
        null,
        { vector: [9] },
        { [hashField]: hashField === 'from_reports' ? [999] : 'changed' },
      ]) {
        const result = await request(
          `mutation ($filter: ${type}FilterType!, $update: ${type}UpdateType!) {
        updateOne${type}(filter: $filter, update: $update) { embedding { vector } }
      }`,
          { filter, update: { set: { embedding } } }
        );
        expect(result[`updateOne${type}`]).toEqual({ embedding: { vector: [...frozen.vector] } });
      }
      expect(await getCollection('history', 'incidents').countDocuments()).toBe(1);
      expect(await getCollection('history', 'reports').countDocuments()).toBe(1);
      expect(await getCollection('customData', 'notifications').countDocuments()).toBe(0);
    }
  );

  it('ignores legacy vectors in bulk incident updates', async () => {
    const result = await request(
      `mutation ($update: IncidentUpdateType!) {
      updateManyIncidents(filter: {}, update: $update) { matchedCount modifiedCount }
    }`,
      { update: { set: { title: 'Bulk update', embedding: oldIncidentEmbedding } } }
    );
    expect(result.updateManyIncidents).toEqual({ matchedCount: 2, modifiedCount: 2 });
    expect(await getCollection('aiidprod', 'incidents').findOne({ incident_id: 1 })).toMatchObject({
      title: 'Bulk update',
      embedding: incidentEmbedding,
    });
    expect(await getCollection('aiidprod', 'incidents').findOne({ incident_id: 2 })).toMatchObject({
      title: 'Bulk update',
      embedding: { vector: [0, 1], from_reports: [] },
    });
    const noop = await request(
      `mutation { updateManyIncidents(filter: {}, update: { set: { embedding: null } }) { matchedCount modifiedCount } }`
    );
    expect(noop.updateManyIncidents).toEqual({ matchedCount: 2, modifiedCount: 0 });
  });

  it.each(['Incident', 'Report', 'Submission'])(
    'accepts but drops legacy vector input on %s creation',
    async (type) => {
      const data =
        type === 'Incident'
          ? {
              incident_id: 3,
              title: 'Created',
              date: incident.date,
              editor_notes: '',
              flagged_dissimilar_incidents: [],
              embedding: oldIncidentEmbedding,
            }
          : {
              ...article,
              ...(type === 'Report'
                ? {
                    report_number: 2,
                    epoch_date_published: 1577836800,
                    epoch_date_submitted: 1577836800,
                  }
                : {}),
              embedding: oldReportEmbedding,
            };
      const result = await request(
        `mutation ($data: ${type}InsertType!) {
      insertOne${type}(data: $data) { title embedding { vector } }
    }`,
        { data }
      );
      expect(result[`insertOne${type}`].embedding).toBeNull();
      const collection =
        type === 'Incident' ? 'incidents' : type === 'Report' ? 'reports' : 'submissions';
      const created = await getCollection('aiidprod', collection)
        .find()
        .sort({ created_at: -1 })
        .limit(1)
        .next();
      expect(created).not.toHaveProperty('embedding');
      await expectPipelineUntouched();
    }
  );

  it('ignores retired-vector changes in notification comparisons, but still detects content changes', () => {
    expect(hasRelevantUpdates(incident, { ...incident, embedding: oldIncidentEmbedding })).toBe(
      false
    );
    expect(hasRelevantUpdates(incident, { ...incident, title: 'Changed title' })).toBe(true);
    expect(hasRelevantUpdates(incident, { ...incident, reports: [2] })).toBe(true);
  });
});
