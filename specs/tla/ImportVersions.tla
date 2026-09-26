---------------------------- MODULE ImportVersions ----------------------------
(***************************************************************************)
(* The import queue (src/queue.ts) together with version replacement      *)
(* (KnowledgeBase.previousVersions / addFile in src/kb.ts), as driven by   *)
(* web uploads (POST /upload in src/web.ts) of files with ONE name.        *)
(*                                                                         *)
(* Granularity: JavaScript runs one callback at a time, so everything      *)
(* between two awaits is one atomic step:                                  *)
(*   Enqueue  = the POST /upload handler after the body is read:           *)
(*              previousVersions, the "ask first" answer, queue.enqueue    *)
(*   Start    = ImportQueue.run taking the next item (before importFn)     *)
(*   Finish   = KnowledgeBase.addFile after `await converter.convert`:     *)
(*              the abort check, getDoc, replaced, titleFor, putDoc,       *)
(*              remove(old) and the queue's bookkeeping, all synchronous   *)
(*   Cancel   = ImportQueue.cancel                                         *)
(*   Remove   = POST /remove (KnowledgeBase.remove)                        *)
(* Conversion itself is the gap between Start and Finish.                  *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Contents,     \* distinct contents uploaded under the same file name
    MaxUploads,   \* uploads per content, so re-uploading after a cancel is covered
    Fix           \* FALSE: the code before the fix; TRUE: after it (see Enqueue and Finish)

NoItem == [c |-> "none", choice |-> "none", replace |-> {}, aborted |-> FALSE]
NoDoc  == [id |-> "none", title |-> 0, added |-> 0, choice |-> "none"]
\* "none": no older version existed, so nobody was asked. "replace" / "keep": the page asked.
Choices == {"none", "replace", "keep"}

VARIABLES
    store,     \* documents from this upload name: [id, title, added, choice]
    queue,     \* items waiting in ImportQueue.jobs
    current,   \* item being converted (ImportQueue.current), or NoItem
    uploads,   \* uploads so far per content (bounds the search)
    clock,     \* import order, for "the oldest replaced version gives its title"
    done,      \* ImportQueue.done
    total,     \* ImportQueue.total
    added,     \* the document the last step added, or NoDoc (history for invariants)
    kept       \* contents the user once chose to keep next to other versions (history)

vars == <<store, queue, current, uploads, clock, done, total, added, kept>>

Ids == {d.id : d \in store}
Titles == {d.title : d \in store}
\* titleFor for an upload: the bare name (1) if free, else the smallest free "name (n)".
FreeTitle == CHOOSE n \in 1..(Cardinality(Contents) * MaxUploads + 1) :
                 n \notin Titles /\ \A m \in 1..(n - 1) : m \in Titles
Pending == Len(queue) + (IF current = NoItem THEN 0 ELSE 1)

Init ==
    /\ store = {}
    /\ queue = <<>>
    /\ current = NoItem
    /\ uploads = [c \in Contents |-> 0]
    /\ clock = 0
    /\ done = 0
    /\ total = 0
    /\ added = NoDoc
    /\ kept = {}

\* previousVersions(file, { name }): nothing when this content is already imported,
\* otherwise every document uploaded under the name. With some, the page asks
\* replace / keep (cancel means nothing is queued); without, it queues at once.
\* Fix: an upload of the same name still queued or converting, with other content, also counts
\* as an earlier version (web.ts asks host.queued()).
Waiting(c) == {i \in {queue[k] : k \in 1..Len(queue)} \cup (IF current = NoItem THEN {} ELSE {current}) : i.c # c}
Enqueue(c) ==
    /\ uploads[c] < MaxUploads
    /\ LET previous == IF c \in Ids THEN {} ELSE store
           \* web.ts looks at the queue whenever previousVersions is empty, also when this content
           \* is imported already: a queued version may replace it before this upload runs.
           ask == previous # {} \/ (Fix /\ Waiting(c) # {})
       IN \E choice \in (IF ask THEN {"replace", "keep"} ELSE {"none"}) :
            /\ queue' = Append(queue, [c |-> c, choice |-> choice, aborted |-> FALSE,
                                      replace |-> IF choice = "replace" THEN {d.id : d \in previous} ELSE {}])
            /\ uploads' = [uploads EXCEPT ![c] = @ + 1]
            /\ total' = total + 1
            /\ UNCHANGED <<store, current, clock, done, kept>>
            /\ added' = NoDoc

Start ==
    /\ current = NoItem
    /\ queue # <<>>
    /\ current' = Head(queue)
    /\ queue' = Tail(queue)
    /\ added' = NoDoc
    /\ UNCHANGED <<store, uploads, clock, done, total, kept>>

\* The queue's loop ends when nothing is left: done and total go back to 0.
Bookkeeping ==
    IF queue = <<>> THEN done' = 0 /\ total' = 0
    ELSE done' = done + 1 /\ total' = total

Finish ==
    /\ current # NoItem
    /\ current' = NoItem
    /\ Bookkeeping
    /\ UNCHANGED <<queue, uploads>>
    /\ IF current.aborted \/ current.c \in Ids
         THEN \* cancelled, or "already present"
              /\ UNCHANGED <<store, clock, kept>>
              /\ added' = NoDoc
         ELSE LET \* Fix: what to replace is decided now, from the versions imported so far
                  replaced == IF Fix THEN IF current.choice = "replace" THEN store ELSE {}
                              ELSE {d \in store : d.id \in current.replace}
                  oldest   == CHOOSE d \in replaced : \A e \in replaced : d.added <= e.added
                  doc      == [id |-> current.c, choice |-> current.choice, added |-> clock + 1,
                               title |-> IF replaced = {} THEN FreeTitle ELSE oldest.title]
              IN /\ store' = (store \ replaced) \cup {doc}
                 /\ clock' = clock + 1
                 /\ added' = doc
                 /\ kept' = IF current.choice = "keep" THEN kept \cup {current.c} ELSE kept

\* Queued files are dropped (total shrinks); the one converting is aborted and
\* finishes as cancelled (it still counts as done).
Cancel ==
    /\ queue' = <<>>
    /\ total' = total - Len(queue)
    /\ current' = IF current = NoItem THEN NoItem ELSE [current EXCEPT !.aborted = TRUE]
    /\ added' = NoDoc
    /\ UNCHANGED <<store, uploads, clock, done, kept>>

Remove(d) ==
    /\ store' = store \ {d}
    /\ added' = NoDoc
    /\ UNCHANGED <<queue, current, uploads, clock, done, total, kept>>

Next ==
    \/ \E c \in Contents : Enqueue(c)
    \/ Start
    \/ Finish
    \/ Cancel
    \/ \E d \in store : Remove(d)

\* Only the queue's own steps are fair; the user may stop acting at any time.
Spec == Init /\ [][Next]_vars /\ WF_vars(Start) /\ WF_vars(Finish)

-----------------------------------------------------------------------------
TypeOK ==
    /\ store \subseteq [id : Contents, title : Nat, added : Nat, choice : Choices]
    /\ current.choice \in Choices
    /\ done \in Nat /\ total \in Nat

\* Citations name documents by title, so titles must stay unique.
UniqueTitles == \A d, e \in store : d # e => d.title # e.title

\* The status bar's "done/total" counts exactly the files still to import.
CountersAgree == total - done = Pending

\* "Replace the old version": right after such an import, it is the only version left.
ReplaceHonored == added.choice = "replace" => store = {added}

\* A second version of the same name is kept only if the user was asked and chose to keep both
\* (for this content, at some point: re-uploading a kept version may bring it back unasked).
NoSilentDuplicates == Cardinality(store) > 1 => \E d \in store : d.choice = "keep" \/ d.id \in kept

\* Every upload is eventually imported, found present, or cancelled: the queue drains.
Drains == <>[](queue = <<>> /\ current = NoItem)
=============================================================================
