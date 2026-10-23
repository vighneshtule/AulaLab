# Class activity history

In the **History** panel, teachers can review class events and notebook versions. Events describe actions; notebook versions can restore content. Student access to versions follows the class rules. Only teachers can view the activity log and aggregate statistics.

## What is recorded

- **Joining and leaving:** the participant's first connection and the closure of their last connection. Multiple tabs count as one presence. On departure, the connection duration and disconnect reason are recorded.
- **Oracle:** a question or task, completion, error, cancellation, and duration. Human and Oracle actions have distinct sources. In **Act** mode at **Detailed** level, each tool call is also recorded separately: `subjectId` is the tool name and `outcome` says whether it succeeded or was refused. Step history lives in the room document and is removed with it; these event rows remain in the activity log.
- **Execution:** a cell accepted into the queue, its start, and its result with duration. Repeating a cell that is already queued and Markdown edits do not count as new runs. `requestSeq` ties the result to the accepted attempt.
- **Answers:** a council decision being submitted or withdrawn. When one participant runs another participant's attempt, the actor and the work owner's `subjectId` are saved.
- **Edits:** participation in a saved editing burst, with its version number. The total size of a change is not attributed to every co-author.
- **Class lifecycle:** ending and resuming a class, kernel management, and thread cleanup.

The detail filter is cumulative: **Important**, **Ordinary**, and **Detailed**. Categories can show participants, the Oracle, execution, answers, the notebook, or class lifecycle separately. While viewing older pages, the feed does not jump to new events; the refresh button returns to the newest events.

The log stores metadata: time, participant, type, target, source, and outcome. It does not copy code, questions, model answers, or access keys. Questions and content versions remain in their existing stores.

## Statistics data

Two GET endpoints are available with a normal room-teacher Bearer token:

```text
/api/sessions/:id/activity?level=detailed&category=all&limit=50&before=:seq
/api/sessions/:id/activity/summary
```

The feed returns `events`, `nextBefore`, and `trimmed`. Filters are applied before pagination; `before` is a cursor for earlier events. The maximum page size is 100. A detailed log is limited to 10,000 events per class. When that limit is exceeded, the oldest rows are removed in small batches, and the interface indicates that the beginning of the feed is no longer available.

The summary is stored separately, so its counters survive trimming of the detailed feed. Each row contains a participant, the attempt owner when applicable, action type, outcome, source, event count, object count, total duration, and first and last event times. It can support summaries of attendance, Oracle use, run attempts, and editing participation. Deleting a class also deletes its log and summary.

## How to interpret the data

These are observable application actions. An open tab does not prove attention; a successful run does not prove a correct solution; and an edit through the interface does not prove independent authorship, since text can be pasted from another source. Teachers should use these measures together with the work itself.

A participant ID belongs to one class. A name is not a student ID; private browsing or another device can create a different identity. Reliable statistics for one student across a course require a class roster or student identifier. People are not matched automatically by similar names.

Events from before this version cannot be recovered. After an unexpected process failure, the last disconnect may not be recorded; a normal restart is marked as `server_shutdown`. Detailed events already deleted are not restored during migration; summaries include only retained records and new events.
