export {
  firebaseCollectionOptions,
  type FirebaseCollectionConfig,
  type FirebaseCollectionUtils,
} from "./firestore"

export {
  TimeoutWaitingForIdsError,
  ExpectedInsertTypeError,
  ExpectedUpdateTypeError,
  ExpectedDeleteTypeError,
  FirestoreIntegrationError,
} from "./errors"

export type {
  FirebaseConversions,
  FirebaseOptionalConversions,
  FirebaseRequiredConversions,
} from "./types"

// Re-export core sync types for user convenience
export type {
  CleanupFn,
  InferSchemaInput,
  InferSchemaOutput,
  LoadSubsetFn,
  LoadSubsetOptions,
  SyncConfig,
  SyncConfigRes,
  SyncMode,
} from "disclearing-db"

// Re-export DeduplicatedLoadSubset for advanced sync implementations
export { DeduplicatedLoadSubset } from "disclearing-db"

// Re-export expression helpers for on-demand sync support
export {
  extractFieldPath,
  extractSimpleComparisons,
  parseLoadSubsetOptions,
  parseOrderByExpression,
  parseWhereExpression,
  walkExpression,
  type FieldPath,
  type ParsedOrderBy,
  type ParseWhereOptions,
  type SimpleComparison,
} from "disclearing-db"
