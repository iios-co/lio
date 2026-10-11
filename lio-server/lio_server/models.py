"""Pydantic models for the lio-server API surface."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

DeltaOp = Literal["create", "update", "move", "delete", "resync"]
"""``resync`` is a server-authored marker, never pushed by a device. It says
"the tree changed too broadly to express as moves — re-read it and reconcile",
which is how a bulk reorganize avoids emitting ~1800 individual move ops."""


class BookmarkNode(BaseModel):
    """A node in the materialized bookmark tree."""

    id: str
    parent_id: str | None = None
    position: int = 0
    title: str = Field("", max_length=4096)
    url: str | None = Field(None, max_length=4096)
    is_folder: bool = False
    date_added: int | None = None
    date_modified: int | None = None
    icon_base64: str | None = Field(None, max_length=200_000)
    # The server watermark of this row's last accepted mutation. A client compares
    # it against its own recorded watermark to tell "I have seen this row's
    # current state" from "the server changed it while I was not listening".
    # Without it a client cannot honour server authority for positions.
    server_version: int = 0


class BookmarkTreeResponse(BaseModel):
    """Full-tree bootstrap response. Nodes are flat; the client rebuilds
    hierarchy from ``parent_id`` + ``position``. ``server_timestamp`` is the
    watermark the client should record as its initial ``since`` value."""

    nodes: list[BookmarkNode]
    server_timestamp: int
    server_version: int = 0


class DeltaOpIn(BaseModel):
    """A single bookmark change pushed by a client."""

    op: DeltaOp
    node_id: str
    parent_id: str | None = None
    index: int | None = None
    title: str | None = Field(None, max_length=4096)
    url: str | None = Field(None, max_length=4096)
    is_folder: bool = False
    date_added: int | None = None
    timestamp: int = Field(..., description="Client wall-clock ms; LWW basis.")
    icon_base64: str | None = Field(None, max_length=200_000)
    # On a `create`, the id of an EXISTING server row this node is the same link
    # as, under a fresh browser's new id. The server folds that row's analytics
    # (visit_count, last_visited_at, date_added) into the new row and removes the
    # old one, so adopting a match never loses its visit history and never leaves
    # a duplicate. Used by the fresh-install content merge.
    merge_from: str | None = None
    op_id: str | None = None


class DeltaPushRequest(BaseModel):
    """Batch of ops from one device. ``device_id`` tags each op's origin so the
    pull endpoint can exclude the sender's own changes (echo suppression)."""
    device_id: str
    ops: list[DeltaOpIn] = Field(..., max_length=1000)


class DeltaPushResponse(BaseModel):
    applied: int
    skipped_stale: int
    server_timestamp: int


class DeltaPullOp(BaseModel):
    """A stored op returned by the incremental pull endpoint."""

    op: DeltaOp
    node_id: str
    payload: dict
    timestamp: int
    origin: str | None = None


class DeltaPullResponse(BaseModel):
    ops: list[DeltaPullOp]
    server_timestamp: int


class SyncOpChanges(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    parent_id: str | None = Field(default=None, alias="parentId")
    index: int | None = None
    title: str | None = Field(None, max_length=4096)
    url: str | None = Field(None, max_length=4096)
    is_folder: bool | None = Field(default=None, alias="isFolder")
    date_added: int | None = Field(default=None, alias="dateAdded")
    date_modified: int | None = Field(default=None, alias="dateModified")
    icon_base64: str | None = Field(default=None, max_length=200_000, alias="iconBase64")
    merge_from: str | None = Field(default=None, alias="mergeFrom")


class SyncOperation(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    operation_id: str = Field(..., alias="operationId")
    client_id: str = Field(..., alias="clientId")
    client_sequence: int = Field(..., alias="clientSequence")
    item_id: str = Field(..., alias="itemId")
    operation: Literal["create", "update", "move", "delete"]
    changes: SyncOpChanges = Field(default_factory=SyncOpChanges)
    last_server_version: int = Field(0, alias="lastServerVersion")


class SyncBatchRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    client_id: str = Field(..., alias="clientId")
    last_server_version: int = Field(0, alias="lastServerVersion")
    operations: list[SyncOperation] = Field(default_factory=list, max_length=1000)


class DeltaChangeData(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="allow")

    parent_id: str | None = Field(default=None, alias="parentId")
    position: int | None = None
    title: str | None = None
    url: str | None = None
    is_folder: bool | None = Field(default=None, alias="isFolder")
    date_added: int | None = Field(default=None, alias="dateAdded")
    date_modified: int | None = Field(default=None, alias="dateModified")
    icon_base64: str | None = Field(default=None, alias="iconBase64")


class DeltaChange(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    server_version: int = Field(..., alias="serverVersion")
    item_id: str = Field(..., alias="itemId")
    operation: DeltaOp
    data: DeltaChangeData = Field(default_factory=DeltaChangeData)


class SyncBatchResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    acknowledged_operations: list[str] = Field(default_factory=list, alias="acknowledgedOperations")
    changes: list[DeltaChange] = Field(default_factory=list)
    current_server_version: int = Field(..., alias="currentServerVersion")
    server_timestamp: int = Field(..., alias="serverTimestamp")

class TabSessionIn(BaseModel):
    device_name: str
    session_json: str = Field(..., max_length=2_000_000, description="JSON blob of windows & tabs.")
    updated_at: int | None = None
    # True only when this push is the FIRST of a new browsing session (browser
    # started, extension installed/updated). It is the only thing that archives
    # the previous live snapshot: a session is archived because it ENDED, never
    # because a tab closed. Inferring boundaries from a falling tab count made
    # ordinary browsing look like a restart.
    session_boundary: bool = False


class TabItem(BaseModel):
    title: str = ""
    url: str | None = None


class TabSessionSummary(BaseModel):
    device_id: str
    device_name: str
    updated_at: int
    tab_count: int
    tabs: list[TabItem] = []  # the actual captured tabs, for the tabs page


class TabSessionsResponse(BaseModel):
    sessions: list[TabSessionSummary]


class TabAdoptResponse(BaseModel):
    device_id: str
    device_name: str
    session_json: str
    updated_at: int


class TabHistorySummary(BaseModel):
    id: int
    device_id: str
    device_name: str
    created_at: int
    tab_count: int
    tabs: list[TabItem] = []


class TabHistoryResponse(BaseModel):
    history: list[TabHistorySummary]

# ---- Visit tracking -------------------------------------------------------


class VisitIncrement(BaseModel):
    node_id: str
    count: int = Field(1, ge=1, le=10_000, description="Number of visits to add.")
    last_visited_at: int | None = None


class VisitBatchRequest(BaseModel):
    increments: list[VisitIncrement] = Field(..., max_length=1000)


class VisitBatchResponse(BaseModel):
    applied: int
    unknown_nodes: int  # increments for node_ids not present in the collection


# ---- Reorder --------------------------------------------------------------


class ReorderRequest(BaseModel):
    """Place a node between two neighbours. Provide the sort_keys of the items
    it should land between (either may be null for an end). The server computes
    the fractional key; alternatively pass an explicit sort_key to set directly.

    Or pass ``index`` (with optional ``parent_id``): the server rebuilds
    ascending keys for the whole sibling group in the requested order — this is
    self-healing, so display order always equals browser ``position`` order."""

    before: str | None = Field(None, description="sort_key of the item above (lower).")
    after: str | None = Field(None, description="sort_key of the item below (higher).")
    sort_key: str | None = Field(None, description="Explicit key; overrides before/after.")
    parent_id: str | None = Field(None, description="Sibling group for index-based placement.")
    index: int | None = Field(None, ge=0, description="Target position among siblings.")


class ReorderResponse(BaseModel):
    node_id: str
    sort_key: str


class DeleteNodeResponse(BaseModel):
    """How many nodes the delete removed (a folder takes its whole subtree)."""

    deleted: int
    node_ids: list[str]


# ---- Bulk reorganize ------------------------------------------------------


class PlacedNodeIn(BaseModel):
    """Where one existing node should end up after a bulk reorganize."""

    id: str
    parent_id: str | None = None
    index: int = Field(0, ge=0, description="Position among its new siblings.")


class NewFolderIn(BaseModel):
    """A folder the reorganize needs to create (e.g. one per domain).

    ``id`` is a client-side placeholder such as ``new:google``; the server mints
    the real id and rewrites every reference to it."""

    id: str = Field(..., description="Placeholder id, referenced by placements.")
    parent_id: str | None = None
    title: str
    index: int = Field(0, ge=0)


class VisitMergeIn(BaseModel):
    """Fold the absorbed nodes' visit counts into the survivor before they are
    deleted, so de-duplicating never loses visit history."""

    survivor: str
    absorbed: list[str]


class ReorganizeRequest(BaseModel):
    """One sweeping, all-or-nothing rearrangement of the tree.

    Applied in a single transaction: either the whole arrangement lands or the
    tree is left exactly as it was. A snapshot is taken first so the change can
    be undone as one step."""

    label: str = Field("Reorganize", max_length=120, description="For the undo entry.")
    new_folders: list[NewFolderIn] = []
    placements: list[PlacedNodeIn] = []
    removed: list[str] = []
    merge_visits: list[VisitMergeIn] = []


class ReorganizeResponse(BaseModel):
    moved: int
    created: int
    removed: int
    visits_merged: int
    snapshot_id: int
    id_map: dict[str, str] = Field(
        default_factory=dict, description="Placeholder folder id -> real id."
    )
    server_timestamp: int


class SnapshotSummary(BaseModel):
    id: int
    label: str
    node_count: int
    created_at: int


class SnapshotListResponse(BaseModel):
    snapshots: list[SnapshotSummary]


class UndoResponse(BaseModel):
    """Result of inverting the newest recorded action."""

    restored_from: int
    label: str
    # How many nodes the undo actually touched (re-inserted, reverted, or
    # dropped). NOT the snapshot's size: a surgical undo leaves links the user
    # deleted afterwards alone, so this is smaller than the tree.
    node_count: int
    remaining_snapshots: int
    server_timestamp: int


# ---- Reports --------------------------------------------------------------


class UsageRow(BaseModel):
    node_id: str
    parent_id: str | None = None
    position: int = 0  # integer position among siblings — the browser tree order
    title: str
    url: str | None = None
    domain: str | None = None
    visit_count: int = 0
    last_visited_at: int | None = None
    date_added: int | None = None  # for the "recently added" sort
    is_folder: bool = False
    sort_key: str | None = None
    ok: bool | None = None  # link liveness: True alive, False dead, None never probed
    http_status: int | None = None
    checked_at: int | None = None  # when this link was last probed (or skipped)
    status_error: str | None = None  # why it is dead, or why it was skipped


class UsageReportResponse(BaseModel):
    rows: list[UsageRow]


class DeadLinkRow(BaseModel):
    node_id: str
    title: str
    url: str | None = None
    http_status: int | None = None
    error: str | None = None
    checked_at: int | None = None


class DeadLinkReportResponse(BaseModel):
    rows: list[DeadLinkRow]


class CheckResponse(BaseModel):
    checked: int
    ok: int
    dead: int
    skipped: int
    # Why nothing was checked, when that happened: an empty sweep used to return
    # all zeros with no explanation, so the console could only show "Check links"
    # doing visibly nothing.
    disabled: bool = False  # the server has liveness checking switched off
    # Human-readable reason for the skipped rows, so the UI can say why a LAN or
    # blocked host was not probed instead of silently ignoring it.
    skip_reason: str | None = None


# ---- Admin ----------------------------------------------------------------


class AdminLoginRequest(BaseModel):
    username: str
    password: str


class AdminSetupRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=8, description="At least 8 characters.")


class AdminStateResponse(BaseModel):
    setup_needed: bool  # true when no admin account has been set
    authenticated: bool  # true when the caller holds a valid admin session
    username: str | None = None  # the admin username when authenticated


class CollectionSummary(BaseModel):
    id: str
    name: str | None = None
    token: str
    created_at: str | None = None
    token_rotated_at: int | None = None
    bookmark_count: int = 0
    device_count: int = 0
    tab_count: int = 0  # total tabs captured across all device sessions
    last_activity: int | None = None


class CollectionInfoResponse(BaseModel):
    """What a device's token actually resolves to on this server."""

    last_change_at: int | None = None  # newest delta ms, for tree-level LWW
    id: str
    name: str | None = None
    bookmark_count: int = 0
    folder_count: int = 0
    device_count: int = 0


class CollectionListResponse(BaseModel):
    collections: list[CollectionSummary]


class CreateCollectionRequest(BaseModel):
    name: str


class RenameCollectionRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class RenameCollectionResponse(BaseModel):
    id: str
    name: str


class CreateCollectionResponse(BaseModel):
    id: str
    name: str
    token: str


class RotateTokenResponse(BaseModel):
    id: str
    token: str
