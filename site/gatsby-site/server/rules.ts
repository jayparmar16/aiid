import { rule } from "graphql-shield";
import { SelectionSetNode } from "graphql";
import { Context, DBChecklist, DBSubscription, DBUser } from "./interfaces";
import { getMongoDbFilter } from "graphql-to-mongodb";
import { SubscriptionType } from "./types/subscription";
import { getSimplifiedType } from "./utils";
import { GraphQLFilter } from "graphql-to-mongodb/lib/src/mongoDbFilter";
import { UserType } from "./types/user";
import config, { Config } from "./config";
import { ChecklistType } from "./types/checklist";

export const isRole = (role: string) => rule()(
    async (parent, args, context: Context, info) => {

        const { user } = context;

        const meetsRole = user && user.roles && user.roles.includes(role);

        const meetsAdmin = user?.roles.includes('admin');


        if (meetsRole || meetsAdmin) {

            return true;
        }

        return new Error('not authorized')
    },
)

export const isSelf = () => rule()(
    async (parent, args, context: Context, info) => {

        const collection = context.client.db('customData').collection('users');
        const simpleType = getSimplifiedType(UserType);
        const filter = getMongoDbFilter(simpleType, args.filter as GraphQLFilter);
        const users = await collection.find<DBUser>(filter).toArray();

        const { user } = context;

        const meetsOwnership = users.every(s => s.userId === user?.id);

        const meetsAdmin = user?.roles.includes('admin');

        if (meetsAdmin || meetsOwnership) {

            return true;
        }

        return new Error('not authorized')
    },
)

export const isSubscriptionOwner = () => rule()(
    async (parent, args, context: Context, info) => {

        const collection = context.client.db('customData').collection('subscriptions');
        const simpleType = getSimplifiedType(SubscriptionType);
        const filter = getMongoDbFilter(simpleType, args.filter as GraphQLFilter);
        const subscriptions = await collection.find<DBSubscription>(filter).toArray();

        const { user } = context;

        const meetsOwnership = subscriptions.every(s => s.userId === user?.id);

        const meetsAdmin = user?.roles.includes('admin');

        if (meetsAdmin || meetsOwnership) {

            return true;
        }

        return new Error('not authorized')
    },
)

export const hasHeaderSecret = (headerName: keyof Config) => rule()(

    async (parent, args, context: Context, info) => {

        const { req } = context;

        const headerValue = req.headers[headerName.toLowerCase()];
        const configValue = config[headerName];

        if (!headerValue || !configValue || (configValue && headerValue && configValue != headerValue)) {

            return new Error('not authorized')
        }

        return true;
    }
)

export const notQueriesAdminData = () => rule()(

    async (parent, args, context: Context, info) => {

        // Walks fragment spreads and inline fragments as well as direct selections;
        // checking only direct selections let `{ user { ...f } } fragment f on User
        // { adminData { email } }` slip past this rule.
        const selectsAdminData = (selectionSet: SelectionSetNode | undefined): boolean => {

            if (!selectionSet) {

                return false;
            }

            for (const selection of selectionSet.selections) {

                if (selection.kind === 'Field' && selection.name.value === 'adminData') {

                    return true;
                }

                if (selection.kind === 'InlineFragment' && selectsAdminData(selection.selectionSet)) {

                    return true;
                }

                if (selection.kind === 'FragmentSpread') {

                    const fragment = info.fragments[selection.name.value];

                    if (fragment && selectsAdminData(fragment.selectionSet)) {

                        return true;
                    }
                }
            }

            return false;
        }

        for (const fieldNode of info.fieldNodes) {

            if (selectsAdminData(fieldNode.selectionSet)) {

                return new Error('not authorized')
            }
        }

        return true;
    }
)

export const isAdmin = isRole('admin');

export const isSubscriber = isRole('subscriber');

export const isChecklistsOwner = () => rule()(
    async (parent, args, context: Context, info) => {

        const collection = context.client.db('aiidprod').collection('checklists');
        const simpleType = getSimplifiedType(ChecklistType);
        const filter = getMongoDbFilter(simpleType, args.filter as GraphQLFilter);
        const checklists = await collection.find<DBChecklist>(filter).toArray();

        const { user } = context;

        const meetsOwnership = checklists.every(c => c.owner_id === user?.id);

        if (!meetsOwnership) {

            return new Error('not authorized');
        }

        return true;
    },
)