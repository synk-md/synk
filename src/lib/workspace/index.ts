/**
 * A notebook as a workspace: an owner established by a signed genesis record,
 * and a directory of member devices carried in the notebook's own index doc.
 */

export type {
  Ownership,
  OwnershipStatus,
  VerifyGenesisOptions,
  WorkspaceGenesis,
  WorkspaceGenesisBody,
} from "./genesis"
export {
  createGenesis,
  genesisBytes,
  GENESIS_VERSION,
  resolveOwnership,
  verifyGenesis,
} from "./genesis"

export type {
  FoundedWorkspace,
  FoundOptions,
  NotebookWorkspace,
  ReadWorkspaceOptions,
} from "./notebook-workspace"
export {
  adminDids,
  foundNotebookWorkspace,
  GENESIS_MAP,
  genesisClaims,
  memberIdFor,
  putGenesis,
  readNotebookWorkspace,
  resourceIdFor,
  workspaceIdFor,
} from "./notebook-workspace"

export {
  authorizationContext,
  CAPABILITY_MAP,
  issueOwnerRoot,
  OWNER_ROOT_DEPTH,
  OWNER_ROOT_TTL_MS,
  ownerHoldsRoot,
  putCapability,
  readCapabilities,
} from "./capabilities"

export type { FoundedKeys, FoundKeysOptions, KeyAccess, NotebookKeys, ReadKeysOptions } from "./notebook-keys"
export {
  EPOCH_MAP,
  foundNotebookKeys,
  KEYRING_MAP,
  keyDomainFor,
  putEpochRecord,
  putSealedKeys,
  readNotebookKeys,
  restoreDomainAdmin,
  sealedKeyId,
  storedEpochRecords,
  storedSealedKeys,
} from "./notebook-keys"
