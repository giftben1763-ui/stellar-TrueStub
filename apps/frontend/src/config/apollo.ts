import {
  ApolloClient,
  InMemoryCache,
  createHttpLink,
  split,
} from "@apollo/client";
import { getMainDefinition } from "@apollo/client/utilities";
import { setContext } from "@apollo/client/link/context";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import { createClient } from "graphql-ws";
import { Kind, OperationTypeNode } from "graphql";
import { auth } from "@/lib/firebase";
import { updateGlobalConnectionState } from "@/hooks/useConnectionStatus";

// Derive the WebSocket URL from the HTTP Hasura URL by swapping the scheme.
// e.g. https://example.hasura.app/v1/graphql  →  wss://example.hasura.app/v1/graphql
function toWsUrl(httpUrl: string | undefined): string {
  if (!httpUrl) return "";
  return httpUrl.replace(/^https?:\/\//, (match) =>
    match === "https://" ? "wss://" : "ws://"
  );
}

const HASURA_WS_URL = toWsUrl(process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL);

// ── WebSocket link (subscriptions) ──────────────────────────────────────────

const wsClient = createClient({
  url: HASURA_WS_URL,

  // Supply the Firebase auth token in the connection-init payload so Hasura
  // can validate the subscription request.
  connectionParams: async () => {
    const currentUser = auth.currentUser;
    const token = currentUser ? await currentUser.getIdToken() : null;
    return token ? { headers: { Authorization: `Bearer ${token}` } } : {};
  },

  // Retry on any close event (the library already excludes fatal close codes
  // like 4400, 4401, 4500, and 1011 from retrying regardless of this flag).
  shouldRetry: () => true,

  // Allow up to 10 reconnection attempts before giving up.
  retryAttempts: 10,
});

// Wire the graphql-ws lifecycle events to the global connection-state store so
// that ConnectionStatus.tsx (and anything else that calls useConnectionStatus)
// reflects the actual WebSocket health in real time.
wsClient.on("connected", () => updateGlobalConnectionState("connected"));
wsClient.on("connecting", () => updateGlobalConnectionState("reconnecting"));
wsClient.on("closed", () => updateGlobalConnectionState("disconnected"));

const wsLink = new GraphQLWsLink(wsClient);

// ── HTTP link (queries & mutations) ─────────────────────────────────────────

const httpLink = createHttpLink({
  uri: process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL,
  fetchOptions: { cache: "no-store" },
});

const authLink = setContext(async (_, { headers }) => {
  const currentUser = auth.currentUser;
  const token = currentUser ? await currentUser.getIdToken() : null;
  return {
    headers: {
      ...headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };
});

// ── Split: subscriptions → WS, everything else → HTTP ───────────────────────

const splitLink = split(
  ({ query }) => {
    const definition = getMainDefinition(query);
    return (
      definition.kind === Kind.OPERATION_DEFINITION &&
      definition.operation === OperationTypeNode.SUBSCRIPTION
    );
  },
  wsLink,
  authLink.concat(httpLink)
);

// ── Apollo Client ────────────────────────────────────────────────────────────

export const apolloClient = new ApolloClient({
  link: splitLink,
  cache: new InMemoryCache(),
});
