// Gatsby's build hooks are CommonJS. Temporarily register TypeScript while loading backend helpers.
// Avoid tsx's namespaced require: tsne-js's legacy cwise dependency reads files via __filename.
const { register } = require('tsx/cjs/api');

const config = require('../../config');

const unregister = register();

let spatial;

try {
  spatial = require('./embeddings/spatial.ts');
} finally {
  unregister();
}

// Production builds have always written incidents.tsne through this connection; the Gatsby
// source connection is not assumed to have write access.
const updateTsneInDatabase = () =>
  spatial.updateTsneInDatabase(
    config.mongodb.translationsConnectionString,
    config.realm.production_db.db_name
  );

module.exports = { updateTsneInDatabase };
