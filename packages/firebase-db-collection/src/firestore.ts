/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import {
  addDoc,
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  onSnapshotsInSync,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  startAfter,
  waitForPendingWrites,
  where,
  writeBatch,
} from "firebase/firestore"
import { DeduplicatedLoadSubset, parseOrderByExpression } from "disclearing-db"
import {
  ExpectedDeleteTypeError,
  ExpectedInsertTypeError,
  ExpectedUpdateTypeError,
  FirestoreIntegrationError,
} from "./errors"
import type {
  BaseCollectionConfig,
  CleanupFn,
  CollectionConfig,
  DeleteMutationFnParams,
  InferSchemaOutput,
  InsertMutationFnParams,
  LoadSubsetOptions,
  SyncConfig,
  SyncConfigRes,
  SyncMode,
  UpdateMutationFnParams,
  UtilsRecord,
} from "disclearing-db"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type {
  CollectionReference,
  DocumentData,
  DocumentReference,
  Firestore,
  FirestoreError,
  Query,
  QueryConstraint,
  QueryDocumentSnapshot,
  QuerySnapshot,
  SnapshotOptions,
  Unsubscribe,
  WhereFilterOp,
  WithFieldValue,
} from "firebase/firestore"
import type { FirebaseConversion, FirebaseConversions, ShapeOf } from "./types"

const FIRESTORE_BATCH_LIMIT = 500

function convert<
  InputType extends ShapeOf<OutputType> & Record<string, unknown>,
  OutputType extends ShapeOf<InputType>,
>(
  conversions: FirebaseConversions<InputType, OutputType>,
  input: InputType
): OutputType {
  const c = conversions as Record<
    string,
    FirebaseConversion<InputType, OutputType>
  >

  return Object.fromEntries(
    Object.keys(input).map((k: string) => {
      const value = input[k]
      return [k, c[k]?.(value as any) ?? value]
    })
  ) as OutputType
}

function convertPartial<
  InputType extends ShapeOf<OutputType> & Record<string, unknown>,
  OutputType extends ShapeOf<InputType>,
>(
  conversions: FirebaseConversions<InputType, OutputType>,
  input: Partial<InputType>
): Partial<OutputType> {
  const c = conversions as Record<
    string,
    FirebaseConversion<InputType, OutputType>
  >

  return Object.fromEntries(
    Object.keys(input).map((k: string) => {
      const value = input[k]
      return [k, c[k]?.(value as any) ?? value]
    })
  ) as OutputType
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== `object`) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeFirestoreValue(value: unknown): unknown {
  if (value === null || value === undefined) return value

  if (value instanceof Date) {
    return value
  }

  if (
    typeof value === `object` &&
    `toDate` in value &&
    typeof value.toDate === `function`
  ) {
    const date = value.toDate()
    if (date instanceof Date) {
      return date
    }
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeFirestoreValue(entry))
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeFirestoreValue(entry),
      ])
    )
  }

  return value
}

function normalizeFirestoreRecord<T extends Record<string, unknown>>(
  record: T
): T {
  return normalizeFirestoreValue(record) as T
}

/**
 * Configuration interface for Firebase Collection
 */
export interface FirebaseCollectionConfig<
  TItem extends ShapeOf<TRecord>,
  TRecord extends ShapeOf<TItem> = TItem,
  TKey extends string = string,
  TSchema extends StandardSchemaV1 = never,
> extends Omit<
  BaseCollectionConfig<TItem, TKey, TSchema, UtilsRecord, any>,
  `sync` | `onInsert` | `onUpdate` | `onDelete`
> {
  /**
   * Firestore instance
   */
  firestore: Firestore

  /**
   * Collection path in Firestore
   */
  collectionPath: string

  /**
   * Page size for initial fetch
   * @default 1000
   */
  pageSize?: number

  /**
   * Parse conversions from Firestore document to TItem
   */
  parse?: FirebaseConversions<TRecord, TItem>

  /**
   * Serialize conversions from TItem to Firestore document
   */
  serialize?: FirebaseConversions<TItem, TRecord>

  /**
   * Custom converter for Firestore documents
   */
  converter?: {
    toFirestore: (data: WithFieldValue<TItem>) => DocumentData
    fromFirestore: (
      snapshot: QueryDocumentSnapshot,
      options: SnapshotOptions
    ) => TRecord
  }

  /**
   * Whether to use auto-generated IDs for new documents
   * @default false
   */
  autoId?: boolean

  /**
   * Initial query constraints (e.g., orderBy, where)
   * These constraints will be applied to both initial fetch and listener
   */
  queryConstraints?: Array<QueryConstraint>

  /**
   * How updates are applied to rows
   * - 'partial': Only specified fields are updated (default)
   * - 'full': Entire row is replaced
   * @default 'partial'
   */
  rowUpdateMode?: `partial` | `full`

  /**
   * Whether to include metadata changes in the listener
   * @default false
   */
  includeMetadataChanges?: boolean

  /**
   * For large collections, provide a query builder
   * This allows users to sync only a subset of data
   */
  queryBuilder?: (baseQuery: Query) => Query

  /**
   * Whether to use transactions for update operations
   * This provides stronger consistency guarantees
   * @default false
   */
  useTransactions?: boolean

  /**
   * Optional handler called when items are inserted.
   * Firebase handles the persistence automatically.
   */
  onInsert?: (params: InsertMutationFnParams<TItem, TKey>) => Promise<void>

  /**
   * Optional handler called when items are updated.
   * Firebase handles the persistence automatically.
   */
  onUpdate?: (params: UpdateMutationFnParams<TItem, TKey>) => Promise<void>

  /**
   * Optional handler called when items are deleted.
   * Firebase handles the persistence automatically.
   */
  onDelete?: (params: DeleteMutationFnParams<TItem, TKey>) => Promise<void>
}

export interface FirebaseCollectionUtils extends UtilsRecord {
  /**
   * Cancel the real-time listener
   */
  cancel: () => void

  /**
   * Get the Firestore collection reference
   */
  getCollectionRef: () => CollectionReference<DocumentData>

  /**
   * Wait for all pending writes to be acknowledged by the server
   */
  waitForSync: () => Promise<void>

  /**
   * Manually trigger a re-fetch of the collection data from Firestore
   */
  refetch: () => Promise<void>

  /**
   * Whether the collection is currently fetching data
   */
  isFetching: boolean

  /**
   * The last error encountered during sync, if any
   */
  lastError: Error | undefined

  /**
   * Whether the collection is in an error state
   */
  isError: boolean

  /**
   * Clear the current error state
   */
  clearError: () => void
}

interface BufferedEvent {
  type: `added` | `modified` | `removed`
  data: any
  doc: QueryDocumentSnapshot
}

async function executeBatchedWrites(
  firestore: Firestore,
  operations: Array<{
    type: `set` | `update` | `delete`
    ref: DocumentReference
    data?: any
  }>
): Promise<void> {
  // Split into chunks of FIRESTORE_BATCH_LIMIT
  for (let i = 0; i < operations.length; i += FIRESTORE_BATCH_LIMIT) {
    const chunk = operations.slice(i, i + FIRESTORE_BATCH_LIMIT)
    const batch = writeBatch(firestore)

    for (const op of chunk) {
      switch (op.type) {
        case `set`:
          batch.set(op.ref, op.data)
          break
        case `update`:
          batch.update(op.ref, op.data)
          break
        case `delete`:
          batch.delete(op.ref)
          break
      }
    }

    await batch.commit()
  }
}

function handleFirestoreError(error: unknown, context: string): never {
  if ((error as FirestoreError).code) {
    const firestoreError = error as FirestoreError
    switch (firestoreError.code) {
      case `permission-denied`:
        throw new FirestoreIntegrationError(`Permission denied: ${context}`)
      case `not-found`:
        throw new FirestoreIntegrationError(`Document not found: ${context}`)
      case `already-exists`:
        throw new FirestoreIntegrationError(
          `Document already exists: ${context}`
        )
      case `resource-exhausted`:
        throw new FirestoreIntegrationError(`Quota exceeded: ${context}`)
      case `unavailable`:
        throw new FirestoreIntegrationError(
          `Service temporarily unavailable: ${context}`
        )
      case `failed-precondition`:
        throw new FirestoreIntegrationError(
          `Operation failed precondition: ${context}`
        )
      case `unimplemented`:
        throw new FirestoreIntegrationError(
          `Operation not supported: ${context}`
        )
      default:
        throw new FirestoreIntegrationError(
          `Firestore error (${firestoreError.code}): ${firestoreError.message}`
        )
    }
  }
  throw error
}

class ExponentialBackoff {
  private attempt = 0
  private readonly maxAttempts = 5
  private readonly baseDelay = 1000

  async execute<T>(operation: () => Promise<T>, context: string): Promise<T> {
    while (this.attempt < this.maxAttempts) {
      try {
        const result = await operation()
        this.reset()
        return result
      } catch (error) {
        this.attempt++

        if (this.attempt >= this.maxAttempts) {
          throw new FirestoreIntegrationError(
            `${context} failed after ${this.maxAttempts} attempts: ${error}`
          )
        }

        const delay = this.baseDelay * Math.pow(2, this.attempt - 1)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    throw new FirestoreIntegrationError(`Unreachable`)
  }

  reset() {
    this.attempt = 0
  }
}

/**
 * Convert a single where expression to Firestore QueryConstraints.
 * Returns an array because AND expressions produce multiple constraints.
 */
function whereExprToFirestore(expr: any): Array<QueryConstraint> {
  if (!expr || expr.type !== `fn`) return []

  const { name, args } = expr

  // Extract field path from a ref expression
  const extractField = (ref: any): string | null => {
    if (ref?.type === `ref`) {
      return Array.isArray(ref.path) ? ref.path.join(`.`) : String(ref.path)
    }
    return null
  }

  // Extract value from a val expression
  const extractValue = (val: any): unknown => {
    if (val?.type === `val`) return val.value
    return undefined
  }

  // Comparison operators: eq, gt, gte, lt, lte, in
  const comparisonOps: Record<string, WhereFilterOp> = {
    eq: `==`,
    gt: `>`,
    gte: `>=`,
    lt: `<`,
    lte: `<=`,
    in: `in`,
  }

  if (comparisonOps[name]) {
    const field = extractField(args[0])
    const value = extractValue(args[1])
    if (field && value !== undefined) {
      return [where(field, comparisonOps[name], value)]
    }
    return []
  }

  // AND: flatten all child constraints into a single array
  if (name === `and`) {
    const result: Array<QueryConstraint> = []
    for (const arg of args) {
      result.push(...whereExprToFirestore(arg))
    }
    return result
  }

  // OR: Firestore doesn't support OR natively
  if (name === `or`) {
    throw new FirestoreIntegrationError(
      `Firestore does not support OR in loadSubset queries. Use separate collections for OR logic.`
    )
  }

  // NOT: invert the inner constraint
  if (name === `not` && args.length === 1) {
    const inner = args[0]
    if (inner?.type === `fn` && inner.name === `eq`) {
      const field = extractField(inner.args[0])
      const value = extractValue(inner.args[1])
      if (field && value !== undefined) {
        return [where(field, `!=`, value)]
      }
    }
    if (inner?.type === `fn` && inner.name === `in`) {
      const field = extractField(inner.args[0])
      const value = extractValue(inner.args[1])
      if (field && value !== undefined) {
        return [where(field, `not-in`, value)]
      }
    }
    throw new FirestoreIntegrationError(
      `Firestore does not support NOT for this operator in loadSubset queries.`
    )
  }

  // isNull / isUndefined
  if (name === `isNull` || name === `isUndefined`) {
    const field = extractField(args[0])
    if (field) {
      return [where(field, `==`, null)]
    }
    return []
  }

  throw new FirestoreIntegrationError(
    `Unsupported operator in loadSubset: '${name}'. Supported: eq, gt, gte, lt, lte, in, and, not, isNull, isUndefined.`
  )
}

/**
 * Convert LoadSubsetOptions into Firestore QueryConstraint objects.
 */
function loadSubsetToQueryConstraints(
  options: LoadSubsetOptions
): Array<QueryConstraint> {
  const constraints: Array<QueryConstraint> = []

  // Convert where predicates to Firestore where clauses
  if (options.where) {
    constraints.push(...whereExprToFirestore(options.where))
  }

  // Convert orderBy to Firestore orderBy
  if (options.orderBy) {
    const sorts = parseOrderByExpression(options.orderBy)
    for (const sort of sorts) {
      const field = Array.isArray(sort.field)
        ? sort.field.join(`.`)
        : String(sort.field)
      constraints.push(orderBy(field, sort.direction))
    }
  }

  // Add limit
  if (options.limit !== undefined) {
    constraints.push(limit(options.limit))
  }

  return constraints
}

// Overload: with schema
export function firebaseCollectionOptions<TSchema extends StandardSchemaV1>(
  config: FirebaseCollectionConfig<
    InferSchemaOutput<TSchema>,
    InferSchemaOutput<TSchema>,
    string,
    TSchema
  > & { schema: TSchema }
): CollectionConfig<InferSchemaOutput<TSchema>, string, TSchema> & {
  utils: FirebaseCollectionUtils
  schema: TSchema
}

// Without schema
export function firebaseCollectionOptions<
  TItem extends ShapeOf<TRecord>,
  TRecord extends ShapeOf<TItem> = TItem,
  TKey extends string = string,
>(
  config: FirebaseCollectionConfig<TItem, TRecord, TKey, never>
): CollectionConfig<TItem, TKey> & {
  utils: FirebaseCollectionUtils
  schema: never
}

// With schema
export function firebaseCollectionOptions<
  TItem extends ShapeOf<TRecord>,
  TRecord extends ShapeOf<TItem> = TItem,
  TKey extends string = string,
>(
  config: FirebaseCollectionConfig<TItem, TRecord, TKey, any>
): CollectionConfig<TItem, TKey, any> & { utils: FirebaseCollectionUtils } {
  const {
    firestore,
    collectionPath,
    pageSize = 1000,
    parse: parseConversions = {} as FirebaseConversions<TRecord, TItem>,
    serialize: serializeConversions = {} as FirebaseConversions<TItem, TRecord>,
    converter,
    autoId = false,
    queryConstraints = [],
    rowUpdateMode = `partial`,
    includeMetadataChanges = false,
    queryBuilder,
    useTransactions = false,
    onInsert: userOnInsert,
    onUpdate: userOnUpdate,
    onDelete: userOnDelete,
    ...restConfig
  } = config

  const syncMode: SyncMode = restConfig.syncMode ?? `eager`
  const getKey = config.getKey || ((item: TItem) => (item as any).id as TKey)

  const parse = (record: TRecord) =>
    convert<TRecord, TItem>(
      parseConversions,
      normalizeFirestoreRecord(record as Record<string, unknown>) as TRecord
    )
  const serialUpd = (item: Partial<TItem>) =>
    convertPartial<TItem, TRecord>(serializeConversions, item)
  const serialIns = (item: TItem) =>
    convert<TItem, TRecord>(serializeConversions, item)

  const collectionRef = collection(firestore, collectionPath)
  const backoff = new ExponentialBackoff()

  let unsubscribeSnapshot: Unsubscribe | undefined
  const cancelSnapshot = () => {
    if (unsubscribeSnapshot) {
      unsubscribeSnapshot()
      unsubscribeSnapshot = undefined
    }
  }

  const waitForSync = (): Promise<void> => {
    return new Promise((resolve) => {
      const unsubscribe = onSnapshotsInSync(firestore, () => {
        unsubscribe()
        resolve()
      })
    })
  }

  let isFetching = false
  let lastError: Error | undefined
  const setIsFetching = (val: boolean) => {
    isFetching = val
  }
  const setError = (err: Error) => {
    lastError = err
  }
  const clearError = () => {
    lastError = undefined
  }

  let refetch: () => Promise<void>
  let loadSubsetDedupe: DeduplicatedLoadSubset | undefined

  type SyncParams = Parameters<SyncConfig<TItem, TKey>[`sync`]>[0]
  const sync: SyncConfig<TItem, TKey> = {
    sync: (params: SyncParams): void | CleanupFn | SyncConfigRes => {
      const {
        begin,
        write,
        commit,
        markReady,
        truncate,
        collection: dbCollection,
      } = params

      const eventBuffer: Array<BufferedEvent> = []
      let isInitialFetchComplete = false
      const fetchedIds = new Set<string>()
      let initialFetchEndTime: Date

      // Build the query with constraints
      let baseQuery: Query = collectionRef
      if (queryConstraints.length > 0) {
        baseQuery = query(collectionRef, ...queryConstraints)
      }

      // Apply custom query builder if provided
      const finalQuery = queryBuilder ? queryBuilder(baseQuery) : baseQuery

      // STEP 1: Start listener immediately (before initial fetch)
      function setupListener() {
        unsubscribeSnapshot = onSnapshot(
          finalQuery,
          { includeMetadataChanges },
          (snapshot: QuerySnapshot) => {
            const events: Array<BufferedEvent> = snapshot
              .docChanges()
              .map((change) => ({
                type: change.type,
                data: converter
                  ? converter.fromFirestore(change.doc, {})
                  : ({
                      id: change.doc.id,
                      ...change.doc.data(),
                    } as unknown as TRecord),
                doc: change.doc,
              }))

            if (!isInitialFetchComplete) {
              // Buffer events during initial fetch
              eventBuffer.push(...events)
            } else {
              // Process events immediately after initial fetch
              processEvents(events)
            }
          },
          (error) => {
            if (error.code === `aborted`) {
              console.warn(
                `[${dbCollection.id}] Firestore listener aborted`,
                error
              )
              return
            }
            console.error(
              `[${dbCollection.id}] Firestore listener error:`,
              error
            )
            handleFirestoreError(error, `real-time sync`)
          }
        )
      }

      function processEvent(event: BufferedEvent) {
        const value = parse(event.data)

        write({
          type:
            event.type === `added`
              ? `insert`
              : event.type === `modified`
                ? `update`
                : `delete`,
          value,
        })
      }

      function processEvents(events: Array<BufferedEvent>) {
        if (events.length === 0) return

        begin()
        events.forEach(processEvent)
        commit()
      }

      // STEP 2: Perform initial fetch
      async function initialFetch() {
        let lastDoc: QueryDocumentSnapshot | null = null
        let hasMore = true

        begin()

        while (hasMore) {
          try {
            const constraints: Array<QueryConstraint> = [
              ...queryConstraints,
              limit(pageSize),
              ...(lastDoc ? [startAfter(lastDoc)] : []),
            ]

            const q = query(collectionRef, ...constraints)
            const snapshot = await getDocs(q)

            if (snapshot.empty) {
              hasMore = false
              break
            }

            snapshot.forEach((docSnap: QueryDocumentSnapshot) => {
              const id = docSnap.id
              fetchedIds.add(id)

              const data = converter
                ? converter.fromFirestore(docSnap, {})
                : ({ id, ...docSnap.data() } as unknown as TRecord)

              write({
                type: `insert`,
                value: parse(data),
              })
            })

            lastDoc = snapshot.docs[snapshot.docs.length - 1] || null
            hasMore = snapshot.docs.length === pageSize
          } catch (error) {
            handleFirestoreError(error, `initial fetch`)
          }
        }

        initialFetchEndTime = new Date()
        commit()
      }

      // STEP 3: Process buffered events
      function processBufferedEvents() {
        if (eventBuffer.length === 0) return

        begin()

        for (const event of eventBuffer) {
          // Skip if we already fetched this document
          if (event.type === `added` && fetchedIds.has(event.data.id)) {
            // Only process if it's newer than our fetch
            const docTime = event.doc.metadata.hasPendingWrites
              ? new Date()
              : event.doc.metadata.fromCache
                ? undefined
                : event.doc.data()?.updatedAt?.toDate?.()

            if (!docTime || docTime <= initialFetchEndTime) {
              continue
            }
          }

          processEvent(event)
        }

        commit()
        eventBuffer.length = 0 // Clear buffer
      }

      // STEP 4: Execute in correct order
      async function start() {
        try {
          setIsFetching(true)
          setupListener() // First! Prevents race condition
          await backoff.execute(() => initialFetch(), `initial fetch`)
          isInitialFetchComplete = true
          processBufferedEvents()
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          setError(err)
          console.error(`[${dbCollection.id}] Sync failed:`, error)
          cancelSnapshot()
          throw error
        } finally {
          setIsFetching(false)
          markReady() // Always call this
        }
      }

      // Set up refetch utility
      refetch = async () => {
        try {
          setIsFetching(true)
          clearError()
          begin()
          truncate()
          commit()
          isInitialFetchComplete = false
          fetchedIds.clear()
          eventBuffer.length = 0
          await backoff.execute(() => initialFetch(), `refetch`)
          isInitialFetchComplete = true
          processBufferedEvents()
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          setError(err)
          throw error
        } finally {
          setIsFetching(false)
        }
      }

      // Set up loadSubset for on-demand sync
      if (syncMode !== `eager`) {
        loadSubsetDedupe = new DeduplicatedLoadSubset({
          loadSubset: async (opts: LoadSubsetOptions) => {
            const subsetConstraints = loadSubsetToQueryConstraints(opts)
            const allConstraints = [...queryConstraints, ...subsetConstraints]
            const q = query(collectionRef, ...allConstraints)
            const snapshot = await getDocs(q)

            if (!snapshot.empty) {
              begin()
              snapshot.forEach((docSnap: QueryDocumentSnapshot) => {
                const id = docSnap.id
                fetchedIds.add(id)

                const data = converter
                  ? converter.fromFirestore(docSnap, {})
                  : ({ id, ...docSnap.data() } as unknown as TRecord)

                write({
                  type: `insert`,
                  value: parse(data),
                })
              })
              commit()
            }
          },
        })
      }

      start()

      // Return SyncConfigRes with cleanup and loadSubset
      const syncRes: SyncConfigRes = {
        cleanup: () => {
          cancelSnapshot()
          loadSubsetDedupe?.reset()
        },
      }

      if (loadSubsetDedupe) {
        syncRes.loadSubset = loadSubsetDedupe.loadSubset
      }

      return syncRes
    },
    rowUpdateMode,
    getSyncMetadata: () => ({
      collectionPath,
    }),
  }

  return {
    ...restConfig,
    sync,
    getKey,
    onInsert: async (
      params: InsertMutationFnParams<TItem, TKey>
    ): Promise<Array<TKey>> => {
      // Call user handler first if provided
      if (userOnInsert) {
        await userOnInsert(params)
      }

      // Always persist to Firestore
      if (autoId) {
        // Can't batch with auto-generated IDs
        const ids = await Promise.all(
          params.transaction.mutations.map(async (mutation) => {
            const { type, modified } = mutation
            if (type !== `insert`) {
              throw new ExpectedInsertTypeError(type)
            }

            const docRef = await backoff.execute(
              () =>
                addDoc(collectionRef, {
                  ...serialIns(modified),
                  createdAt: serverTimestamp(),
                }),
              `insert document`
            )

            return docRef.id as TKey
          })
        )

        await waitForPendingWrites(firestore)
        await waitForSync()
        return ids
      } else {
        // Use batched approach
        const operations = params.transaction.mutations.map((mutation) => {
          const { type, modified } = mutation
          if (type !== `insert`) {
            throw new ExpectedInsertTypeError(type)
          }

          const id = String(getKey(modified))
          return {
            type: `set` as const,
            ref: doc(collectionRef, id),
            data: {
              ...serialIns(modified),
              createdAt: serverTimestamp(),
            },
          }
        })

        await backoff.execute(
          () => executeBatchedWrites(firestore, operations),
          `batch insert`
        )

        await waitForPendingWrites(firestore)
        await waitForSync()
        return params.transaction.mutations.map((m) => getKey(m.modified))
      }
    },
    onUpdate: async (params: UpdateMutationFnParams<TItem, TKey>) => {
      // Call user handler first if provided
      if (userOnUpdate) {
        await userOnUpdate(params)
      }

      // Always persist to Firestore
      if (useTransactions) {
        // Use transactions for stronger consistency
        await Promise.all(
          params.transaction.mutations.map(async (mutation) => {
            const { type, changes, key } = mutation
            if (type !== `update`) {
              throw new ExpectedUpdateTypeError(type)
            }

            const docRef = doc(collectionRef, String(key))

            await runTransaction(firestore, async (transaction) => {
              const docSnap = await transaction.get(docRef)
              if (!docSnap.exists()) {
                throw new FirestoreIntegrationError(`Document ${key} not found`)
              }

              transaction.update(docRef, {
                ...serialUpd(changes),
                updatedAt: serverTimestamp(),
              })
            })
          })
        )
      } else {
        // Use batched writes
        const operations = params.transaction.mutations.map((mutation) => {
          const { type, changes, key } = mutation
          if (type !== `update`) {
            throw new ExpectedUpdateTypeError(type)
          }

          return {
            type: `update` as const,
            ref: doc(collectionRef, String(key)),
            data: {
              ...serialUpd(changes),
              updatedAt: serverTimestamp(),
            },
          }
        })

        await backoff.execute(
          () => executeBatchedWrites(firestore, operations),
          `batch update`
        )
      }

      await waitForPendingWrites(firestore)
      await waitForSync()
    },
    onDelete: async (params: DeleteMutationFnParams<TItem, TKey>) => {
      // Call user handler first if provided
      if (userOnDelete) {
        await userOnDelete(params)
      }

      // Always persist to Firestore
      const operations = params.transaction.mutations.map((mutation) => {
        const { type, key } = mutation
        if (type !== `delete`) {
          throw new ExpectedDeleteTypeError(type)
        }

        return {
          type: `delete` as const,
          ref: doc(collectionRef, String(key)),
        }
      })

      await backoff.execute(
        () => executeBatchedWrites(firestore, operations),
        `batch delete`
      )

      await waitForPendingWrites(firestore)
      await waitForSync()
    },
    utils: {
      cancel: cancelSnapshot,
      getCollectionRef: () => collectionRef,
      waitForSync,
      get refetch() {
        if (!refetch) {
          throw new FirestoreIntegrationError(
            `refetch is not available until the collection has started syncing`
          )
        }
        return refetch
      },
      get isFetching() {
        return isFetching
      },
      get lastError() {
        return lastError
      },
      get isError() {
        return lastError !== undefined
      },
      clearError,
    },
  }
}
