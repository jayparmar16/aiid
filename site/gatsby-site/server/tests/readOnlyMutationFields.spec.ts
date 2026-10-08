import { graphql, GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql';
import { ObjectId } from 'bson';
import { generateMutationFields } from '../utils';

const Type = new GraphQLObjectType({
  name: 'ReadOnlyProbe',
  fields: {
    title: { type: GraphQLString },
    embedding: {
      type: new GraphQLObjectType({
        name: 'ProbeEmbedding',
        fields: { source: { type: GraphQLString } },
      }),
    },
  },
});

const operations = [
  [
    'insertOne',
    'mutation { insertOneProbe(data: { title: "changed", embedding: { source: "legacy" } }) { title } }',
  ],
  [
    'insertMany',
    'mutation { insertManyProbes(data: [{ title: "changed", embedding: { source: "legacy" } }]) { insertedIds } }',
  ],
  [
    'updateOne',
    'mutation { updateOneProbe(filter: {}, update: { set: { title: "changed", embedding: { source: "legacy" } } }) { title } }',
  ],
  [
    'updateMany',
    'mutation { updateManyProbes(filter: {}, update: { set: { title: "changed", embedding: { source: "legacy" } } }) { matchedCount } }',
  ],
  [
    'upsertOne',
    'mutation { upsertOneProbe(filter: {}, update: { title: "changed", embedding: { source: "legacy" } }) { title } }',
  ],
] as const;

describe('opt-in read-only mutation fields', () => {
  const harness = (guarded: boolean) => {
    const id = new ObjectId();
    const collection = {
      insertOne: jest.fn().mockResolvedValue({ insertedId: id }),
      insertMany: jest.fn().mockResolvedValue({ insertedIds: { 0: id } }),
      updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
      updateMany: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
      findOne: jest
        .fn()
        .mockResolvedValue({ _id: id, title: 'existing', embedding: { source: 'frozen' } }),
    };
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'ProbeQuery',
        fields: { dummy: { type: GraphQLString } },
      }),
      mutation: new GraphQLObjectType({
        name: 'ProbeMutation',
        fields: generateMutationFields({
          collectionName: 'probes',
          Type,
          ...(guarded ? { readOnlyFields: ['embedding'] } : {}),
        }),
      }),
    });
    const run = (source: string) =>
      graphql({
        schema,
        source,
        contextValue: { client: { db: () => ({ collection: () => collection }) } },
      });
    return { collection, run };
  };

  it.each(operations)(
    'protects flattened input for %s without stripping other content',
    async (operation, query) => {
      const { collection, run } = harness(true);
      expect((await run(query)).errors).toBeUndefined();
      const write = operation === 'upsertOne' ? 'updateOne' : operation;
      const args = collection[write].mock.calls[0];
      const data =
        operation === 'insertOne'
          ? args[0]
          : operation === 'insertMany'
          ? args[0][0]
          : args[1].$set;
      expect(data.title).toBe('changed');
      expect(
        Object.keys(data).some((key) => key === 'embedding' || key.startsWith('embedding.'))
      ).toBe(false);
    }
  );

  it('leaves unrelated collections writable when no read-only fields are configured', async () => {
    const { collection, run } = harness(false);
    expect((await run(operations[0][1])).errors).toBeUndefined();
    expect(collection.insertOne.mock.calls[0][0]).toMatchObject({ 'embedding.source': 'legacy' });
  });
});
