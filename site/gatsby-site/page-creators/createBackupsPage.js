const path = require('path');

const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const config = require('../config');

const createSnapshotsPage = (createPage, backups = [], annotatedDatasets = []) => {
  createPage({
    path: '/research/snapshots',
    component: path.resolve('./src/templates/backups.js'),
    context: { backups, annotatedDatasets },
  });
};

const createBackupsPage = async (_, createPage) => {
  try {
    const S3 = new S3Client({
      region: 'auto',
      endpoint: `https://${config.cloudflareR2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.cloudflareR2.accessKeyId,
        secretAccessKey: config.cloudflareR2.secretAccessKey,
      },
      forcePathStyle: true,
    });

    const result = await S3.send(
      new ListObjectsV2Command({ Bucket: config.cloudflareR2.bucketName })
    );

    const allObjects = result.Contents ?? [];

    const annotatedDatasets = allObjects
      .filter((obj) => obj.Key.startsWith('AIID_Annotated_Dataset-') && obj.Key.endsWith('.xlsx'))
      .sort((a, b) => (a.Key < b.Key ? 1 : a.Key > b.Key ? -1 : 0));

    const backups = allObjects
      .filter((obj) => !obj.Key.startsWith('AIID_Annotated_Dataset-'))
      .sort((a, b) => (a.Key < b.Key ? 1 : a.Key > b.Key ? -1 : 0));

    createSnapshotsPage(createPage, backups, annotatedDatasets);
  } catch (error) {
    console.warn(
      `[createBackupsPage] R2 listing failed: ${error.message}. Creating page with empty data.`
    );
    createSnapshotsPage(createPage);
  }
};

module.exports = createBackupsPage;
