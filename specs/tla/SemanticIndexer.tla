--------------------------- MODULE SemanticIndexer ---------------------------
(***************************************************************************)
(* The background embedding loop (SemanticIndexer in                       *)
(* src/semantic/indexer.ts) with the calls that drive it from src/kb.ts:   *)
(*   Kick         = indexer.kick() after an import or sync                  *)
(*   UseAndKick   = applyChanges: applySemantic() -> indexer.use(p), then   *)
(*                  indexer.kick(), in one synchronous call                 *)
(*   EditAndKick  = editing a note: indexWikiFile -> store.putDoc (deletes  *)
(*                  its chunks and vectors, inserts new chunks), then kick  *)
(* and the loop's own steps between awaits:                                *)
(*   EmbedDone    = `await provider.embed(...)` resolves: abort check,      *)
(*                  vectors.put (skips chunks whose rowid+doc are gone)     *)
(*   YieldDone    = `await setImmediate` resolves: next pending batch       *)
(*                                                                         *)
(* One note with one chunk. SQLite reuses the rowid of the chunk a         *)
(* rewrite deleted (FTS5 has no AUTOINCREMENT), and the note keeps its id, *)
(* so vectors.put's "is the chunk still there" check always passes: the   *)
(* model has a single chunk slot whose content version is `ver`.           *)
(*                                                                         *)
(* A loop's exit and the `.finally` that clears `running` are one step:    *)
(* the finally is a microtask queued by that same exit, and no macrotask   *)
(* (web request, config change, import) can run in between.               *)
(*                                                                         *)
(* Fix = TRUE models the fixes in the code: a loop that stops early with   *)
(* `again` set starts over for the current provider (kick's do/while),     *)
(* stop() clears `again`, and put stores a vector only for unchanged text. *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Providers,   \* embedding models, e.g. {A, B}
    MaxVer,      \* how many versions of the note's text (edits = MaxVer - 1)
    MaxUses,     \* provider switches
    Fix          \* FALSE: the code as it is; TRUE: with the candidate fixes

CONSTANT None

VARIABLES
    provider,   \* SemanticIndexer.provider
    ver,        \* version of the chunk's current text
    vec,        \* per model: text version the stored vector was made from (0 = none)
    lp,         \* provider of the running loop (its `const provider`), or None when not running
    pc,         \* where the running loop waits: "embedding" or "yield"
    aborted,    \* the running loop's aborter.signal.aborted
    snap,       \* text version the in-flight embed was computed from
    again,      \* SemanticIndexer.again
    uses        \* provider switches so far (bounds the search)

vars == <<provider, ver, vec, lp, pc, aborted, snap, again, uses>>

\* vectors.pending(): chunks with NO vector for the model (LEFT JOIN ... IS NULL). A stale vector
\* does not count, so it is never embedded again. Evaluated inside actions after vec' is set.
Pending(p) == vec'[p] = 0

\* The synchronous part of the loop from `for (;;)` on, for loop provider p: stop if aborted or
\* the provider changed; otherwise take the pending chunk and await embed, or leave the loop.
\* Leaving through `break` ends with again = FALSE (do { again = false ... } while (again) found
\* nothing more to do in the same synchronous run); an early `return` leaves `again` as it is.
Stop(p, isAborted) ==
    IF isAborted \/ provider' # p
      THEN IF Fix /\ again /\ provider' # None /\ Pending(provider')
             THEN \* candidate fix: the finally sees `again` and starts a loop for the current provider
                  /\ lp' = provider' /\ pc' = "embedding" /\ aborted' = FALSE /\ snap' = ver'
                  /\ UNCHANGED again
             ELSE /\ lp' = None /\ pc' = "embedding" /\ aborted' = FALSE /\ snap' = 0
                  /\ UNCHANGED again
      ELSE IF Pending(p)
             THEN lp' = p /\ pc' = "embedding" /\ aborted' = isAborted /\ snap' = ver' /\ again' = FALSE
             ELSE lp' = None /\ pc' = "embedding" /\ aborted' = FALSE /\ snap' = 0 /\ again' = FALSE

\* kick(): nothing without a provider; `again` while a loop runs; otherwise start one,
\* which runs synchronously up to its first await (or to the end).
KickAfter ==
    IF provider' = None THEN UNCHANGED <<lp, pc, aborted, snap, again>>
    ELSE IF lp # None
      THEN again' = TRUE /\ UNCHANGED <<lp, pc, aborted, snap>>
      ELSE IF Pending(provider')
        THEN lp' = provider' /\ pc' = "embedding" /\ aborted' = FALSE /\ snap' = ver' /\ again' = FALSE
        ELSE UNCHANGED <<lp, pc, aborted, snap>> /\ again' = FALSE

Init ==
    /\ provider = None
    /\ ver = 1
    /\ vec = [p \in Providers |-> 0]
    /\ lp = None /\ pc = "embedding" /\ aborted = FALSE /\ snap = 0
    /\ again = FALSE
    /\ uses = 0

Kick ==
    /\ UNCHANGED <<provider, ver, vec, uses>>
    /\ KickAfter

\* use(p): stop() aborts the running loop, purgeOtherModels drops other models' vectors;
\* then applyChanges kicks. The old loop may still be awaiting embed.
UseAndKick(p) ==
    /\ uses < MaxUses
    /\ p # provider
    /\ provider' = p
    /\ uses' = uses + 1
    /\ vec' = [m \in Providers |-> IF m = p THEN vec[m] ELSE 0]
    /\ UNCHANGED ver
    /\ IF lp # None
         THEN \* stop() then kick(): the loop is marked aborted and `again` is set
              \* (with Fix, stop() also clears `again`, so only this kick counts)
              aborted' = TRUE /\ again' = ((p # None) \/ (again /\ ~Fix)) /\ UNCHANGED <<lp, pc, snap>>
         ELSE KickAfter

\* putDoc: new chunk text under the same rowid and doc id, the doc's vectors deleted; then kick.
EditAndKick ==
    /\ ver < MaxVer
    /\ ver' = ver + 1
    /\ vec' = [m \in Providers |-> 0]
    /\ UNCHANGED <<provider, uses>>
    /\ KickAfter

\* `await provider.embed` resolves. The abort check, then vectors.put: the chunk's rowid and
\* doc id are still there, so the vector is stored (with Fix: only if the text is unchanged).
EmbedDone ==
    /\ lp # None /\ pc = "embedding"
    /\ UNCHANGED <<provider, ver, uses>>
    /\ IF aborted \/ provider # lp
         THEN /\ UNCHANGED vec
              /\ Stop(lp, aborted)
         ELSE /\ vec' = [vec EXCEPT ![lp] = IF Fix /\ snap # ver THEN @ ELSE snap]
              /\ pc' = "yield"
              /\ UNCHANGED <<lp, aborted, snap, again>>

\* `await setImmediate` resolves: back to the top of `for (;;)`.
YieldDone ==
    /\ lp # None /\ pc = "yield"
    /\ UNCHANGED <<provider, ver, vec, uses>>
    /\ Stop(lp, aborted)

Next ==
    \/ Kick
    \/ \E p \in Providers \cup {None} : UseAndKick(p)
    \/ EditAndKick
    \/ EmbedDone
    \/ YieldDone

\* The loop's steps are fair (awaited work completes); the user may stop acting at any time.
Spec == Init /\ [][Next]_vars /\ WF_vars(EmbedDone) /\ WF_vars(YieldDone)

-----------------------------------------------------------------------------
TypeOK ==
    /\ provider \in Providers \cup {None}
    /\ ver \in 1..MaxVer
    /\ vec \in [Providers -> 0..MaxVer]
    /\ lp \in Providers \cup {None}
    /\ again \in BOOLEAN

\* A stored vector was made from the chunk's current text.
NoStaleVector == \A p \in Providers : vec[p] \in {0, ver}

\* Once the user stops switching models, the current model's vectors get built.
EventuallyIndexed == \A p \in Providers : <>[](provider = p) => <>[](vec[p] = ver)
=============================================================================
