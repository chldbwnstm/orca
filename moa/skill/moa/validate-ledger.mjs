#!/usr/bin/env node
// Validate a MoA decision ledger against the v3 shape.
//
// Dependency-free on purpose: the coordinator runs this mid-run inside whatever
// worktree it happens to be in, so it must not need an install step. That means
// this is a hand-written checker for the rules that actually catch mistakes
// (required keys, enums, closed objects, seat-label pattern), not a general
// JSON Schema engine — ledger.schema.json stays the readable specification.
//
//   node validate-ledger.mjs <ledger.json>
//
// Exit 0 = well formed. Exit 1 = one line per problem, each with a JSON path.

import { readFileSync } from 'node:fs'
import process from 'node:process'

const problems = []
const fail = (path, message) => problems.push(`${path}: ${message}`)

const SEAT = /^seat-[A-Z]$/
const CONFIDENCE = ['low', 'medium', 'high']
const VERDICTS = ['support', 'challenge', 'merge']
const VOTES = ['reject', 'support', 'concede', 'abstain']
const STATUS = ['active', 'seat_failed']
const MODES = ['summary', 'full']
const ADOPTED_TYPES = ['single', 'merge']
const FORCED_BY = ['round_cap', 'seat_attrition', 'tie', 'insufficient_verified', null]
const ROUND_KINDS = ['deliberation', 'rebuttal']
const DEFENCE_ACTIONS = ['defend', 'amend', 'concede']
const CHALLENGE_ACTIONS = ['confirm', 'withdraw']

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function checkObject(path, value, { required = [], allowed = [] }) {
  if (!isObject(value)) {
    fail(path, `expected an object, got ${Array.isArray(value) ? 'array' : typeof value}`)
    return false
  }
  for (const key of required) {
    if (!(key in value)) {
      fail(path, `missing required key '${key}'`)
    }
  }
  const known = new Set([...required, ...allowed])
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      fail(`${path}.${key}`, 'unexpected key (this object does not allow extra properties)')
    }
  }
  return true
}

function checkEnum(path, value, allowed) {
  if (value === undefined) {
    return
  }
  if (!allowed.includes(value)) {
    const rendered = allowed.map((v) => (v === null ? 'null' : `'${v}'`)).join(', ')
    fail(path, `expected one of ${rendered}, got ${JSON.stringify(value)}`)
  }
}

// Every value check below ignores `undefined`: a missing key is already reported once by the
// enclosing checkObject's required list, and reporting it twice buries the real problems.
function checkString(path, value) {
  if (value === undefined) {
    return
  }
  if (typeof value !== 'string') {
    fail(path, `expected a string, got ${JSON.stringify(value)}`)
  }
}

function checkSeatLabel(path, value) {
  if (value === undefined) {
    return
  }
  if (typeof value !== 'string' || !SEAT.test(value)) {
    fail(path, `expected a seat label matching ${SEAT}, got ${JSON.stringify(value)}`)
  }
}

function checkArray(path, value) {
  if (value === undefined) {
    return null
  }
  if (!Array.isArray(value)) {
    fail(path, `expected an array, got ${JSON.stringify(value)}`)
    return null
  }
  return value
}

function checkBoolean(path, value) {
  if (value === undefined) {
    return
  }
  if (typeof value !== 'boolean') {
    fail(path, `expected a boolean, got ${JSON.stringify(value)}`)
  }
}

function checkInteger(path, value, min) {
  if (value === undefined) {
    return
  }
  if (!Number.isInteger(value) || value < min) {
    fail(path, `expected an integer >= ${min}, got ${JSON.stringify(value)}`)
  }
}

function checkStringMap(path, value, itemCheck) {
  if (value === undefined) {
    return
  }
  if (!isObject(value)) {
    fail(path, 'expected an object map')
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    itemCheck(`${path}.${key}`, entry)
  }
}

function checkIdentity(path, value, { nullable = false } = {}) {
  if (value === undefined) {
    return
  }
  if (value === null) {
    if (!nullable) {
      fail(path, 'may not be null')
    }
    return
  }
  if (!isObject(value)) {
    fail(path, 'expected an identity object')
    return
  }
  if (!('agent' in value)) {
    fail(path, "missing required key 'agent'")
  }
  // Deliberately open: identity carries effort and whatever else a runtime reports.
  for (const key of ['agent', 'model', 'effort']) {
    if (key in value && value[key] !== null && typeof value[key] !== 'string') {
      fail(`${path}.${key}`, 'expected a string or null')
    }
  }
}

function checkSeat(path, seat) {
  if (
    !checkObject(path, seat, {
      required: ['seat', 'requested', 'verified', 'status'],
      allowed: [
        'reported',
        'verification_note',
        'tab',
        'worktree',
        'task',
        'dispatch',
        'terminal',
        'failure'
      ]
    })
  ) {
    return
  }
  checkSeatLabel(`${path}.seat`, seat.seat)
  checkIdentity(`${path}.requested`, seat.requested)
  checkIdentity(`${path}.reported`, seat.reported, { nullable: true })
  if (
    !(
      seat.verified === true ||
      seat.verified === false ||
      seat.verified === null ||
      seat.verified === 'self'
    )
  ) {
    fail(
      `${path}.verified`,
      `expected true, false, null or 'self', got ${JSON.stringify(seat.verified)}`
    )
  }
  checkEnum(`${path}.status`, seat.status, STATUS)
  for (const key of [
    'verification_note',
    'tab',
    'worktree',
    'task',
    'dispatch',
    'terminal',
    'failure'
  ]) {
    checkString(`${path}.${key}`, seat[key])
  }
}

function checkProposal(path, proposal) {
  if (
    !checkObject(path, proposal, {
      required: ['id', 'seat', 'idea'],
      allowed: [
        'proposal',
        'key_points',
        'confidence',
        'resurfaces',
        'amended_in_round',
        'store_entry_id',
        'report'
      ]
    })
  ) {
    return
  }
  checkString(`${path}.id`, proposal.id)
  checkSeatLabel(`${path}.seat`, proposal.seat)
  checkString(`${path}.idea`, proposal.idea)
  checkString(`${path}.proposal`, proposal.proposal)
  checkString(`${path}.store_entry_id`, proposal.store_entry_id)
  checkString(`${path}.report`, proposal.report)
  checkEnum(`${path}.confidence`, proposal.confidence, CONFIDENCE)
  const points = checkArray(`${path}.key_points`, proposal.key_points)
  points?.forEach((point, i) => checkString(`${path}.key_points[${i}]`, point))
  if (proposal.resurfaces !== undefined && proposal.resurfaces !== null) {
    checkString(`${path}.resurfaces`, proposal.resurfaces)
  }
  checkInteger(`${path}.amended_in_round`, proposal.amended_in_round, 2)
}

function checkVerdict(path, verdict, protocol) {
  if (
    !checkObject(path, verdict, {
      required: ['from', 'target', 'verdict', 'rationale'],
      allowed: ['merge_with', 'base', 'store_entry_id']
    })
  ) {
    return
  }
  checkSeatLabel(`${path}.from`, verdict.from)
  checkSeatLabel(`${path}.target`, verdict.target)
  checkEnum(`${path}.verdict`, verdict.verdict, VERDICTS)
  checkString(`${path}.rationale`, verdict.rationale)
  checkString(`${path}.store_entry_id`, verdict.store_entry_id)
  const mergeWith = checkArray(`${path}.merge_with`, verdict.merge_with)
  mergeWith?.forEach((seat, i) => checkString(`${path}.merge_with[${i}]`, seat))
  checkSeatLabel(`${path}.base`, verdict.base)
  // v3-only: a merge that does not say what it is built on cannot be tallied for a base majority.
  if (protocol === 'v3' && verdict.verdict === 'merge' && verdict.base === undefined) {
    fail(`${path}.base`, "required on a 'merge' verdict under protocol v3")
  }
}

function checkRebuttal(path, rebuttal) {
  if (!checkObject(path, rebuttal, { required: ['seat'], allowed: ['defence', 'challenges'] })) {
    return
  }
  checkSeatLabel(`${path}.seat`, rebuttal.seat)
  if (rebuttal.defence !== undefined) {
    const dp = `${path}.defence`
    if (
      checkObject(dp, rebuttal.defence, {
        required: ['action', 'rationale'],
        allowed: ['amended_proposal']
      })
    ) {
      checkEnum(`${dp}.action`, rebuttal.defence.action, DEFENCE_ACTIONS)
      checkString(`${dp}.rationale`, rebuttal.defence.rationale)
      checkString(`${dp}.amended_proposal`, rebuttal.defence.amended_proposal)
    }
  }
  const challenges = checkArray(`${path}.challenges`, rebuttal.challenges)
  challenges?.forEach((challenge, i) => {
    const cp = `${path}.challenges[${i}]`
    if (checkObject(cp, challenge, { required: ['target', 'action', 'rationale'], allowed: [] })) {
      checkSeatLabel(`${cp}.target`, challenge.target)
      checkEnum(`${cp}.action`, challenge.action, CHALLENGE_ACTIONS)
      checkString(`${cp}.rationale`, challenge.rationale)
    }
  })
}

function checkRound(path, round, protocol) {
  if (
    !checkObject(path, round, {
      required: ['round', 'verdicts'],
      allowed: [
        'kind',
        'rebuttals',
        'rankings',
        'concessions',
        'derived_concessions',
        'base_tally',
        'convergence',
        'protocol_note',
        'store'
      ]
    })
  ) {
    return
  }
  checkInteger(`${path}.round`, round.round, 2)
  checkEnum(`${path}.kind`, round.kind, ROUND_KINDS)
  const verdicts = checkArray(`${path}.verdicts`, round.verdicts)
  verdicts?.forEach((verdict, i) => checkVerdict(`${path}.verdicts[${i}]`, verdict, protocol))
  const rebuttals = checkArray(`${path}.rebuttals`, round.rebuttals)
  rebuttals?.forEach((rebuttal, i) => checkRebuttal(`${path}.rebuttals[${i}]`, rebuttal))
  checkStringMap(`${path}.rankings`, round.rankings, (p, entry) => {
    const list = checkArray(p, entry)
    list?.forEach((seat, i) => checkString(`${p}[${i}]`, seat))
  })
  for (const key of ['concessions', 'derived_concessions']) {
    checkStringMap(`${path}.${key}`, round[key], checkBoolean)
  }
  checkStringMap(`${path}.base_tally`, round.base_tally, (p, entry) => {
    if (!Number.isInteger(entry) || entry < 0) {
      fail(p, 'expected a non-negative integer')
    }
  })
  checkStringMap(`${path}.store`, round.store, (p, entry) => checkString(p, entry))
  checkString(`${path}.convergence`, round.convergence)
  checkString(`${path}.protocol_note`, round.protocol_note)
}

function checkResolution(path, resolution) {
  if (resolution === undefined || resolution === null) {
    return
  }
  if (
    !checkObject(path, resolution, {
      required: ['adopted', 'rejected'],
      allowed: ['dissent', 'chair_additions', 'resolution_forced_by', 'store']
    })
  ) {
    return
  }

  const ap = `${path}.adopted`
  if (
    checkObject(ap, resolution.adopted, {
      required: ['sources', 'type', 'rationale'],
      allowed: ['base', 'store_entry_id']
    })
  ) {
    const sources = checkArray(`${ap}.sources`, resolution.adopted.sources)
    if (sources && sources.length === 0) {
      fail(`${ap}.sources`, 'expected at least one source')
    }
    sources?.forEach((source, i) => checkString(`${ap}.sources[${i}]`, source))
    checkEnum(`${ap}.type`, resolution.adopted.type, ADOPTED_TYPES)
    checkString(`${ap}.rationale`, resolution.adopted.rationale)
    checkString(`${ap}.base`, resolution.adopted.base)
    checkString(`${ap}.store_entry_id`, resolution.adopted.store_entry_id)
  }

  const rejected = checkArray(`${path}.rejected`, resolution.rejected)
  rejected?.forEach((item, i) => {
    const rp = `${path}.rejected[${i}]`
    if (
      checkObject(rp, item, {
        required: ['proposal', 'rationale', 'votes', 'unanimous'],
        allowed: ['store_entry_id']
      })
    ) {
      checkString(`${rp}.proposal`, item.proposal)
      checkString(`${rp}.rationale`, item.rationale)
      checkString(`${rp}.store_entry_id`, item.store_entry_id)
      checkBoolean(`${rp}.unanimous`, item.unanimous)
      if (!isObject(item.votes)) {
        fail(`${rp}.votes`, 'expected an object map of seat -> vote')
      } else {
        for (const [seat, vote] of Object.entries(item.votes)) {
          checkSeatLabel(`${rp}.votes.${seat} (key)`, seat)
          checkEnum(`${rp}.votes.${seat}`, vote, VOTES)
        }
      }
    }
  })

  const dissent = checkArray(`${path}.dissent`, resolution.dissent)
  dissent?.forEach((item, i) => {
    const dp = `${path}.dissent[${i}]`
    if (checkObject(dp, item, { required: ['seat', 'position'], allowed: [] })) {
      checkSeatLabel(`${dp}.seat`, item.seat)
      checkString(`${dp}.position`, item.position)
    }
  })

  const additions = checkArray(`${path}.chair_additions`, resolution.chair_additions)
  additions?.forEach((item, i) => checkString(`${path}.chair_additions[${i}]`, item))
  checkEnum(`${path}.resolution_forced_by`, resolution.resolution_forced_by, FORCED_BY)
  checkStringMap(`${path}.store`, resolution.store, (p, entry) => checkString(p, entry))
}

function validate(ledger) {
  if (!isObject(ledger)) {
    fail('$', 'expected the ledger to be a JSON object')
    return
  }
  for (const key of ['slug', 'problem', 'mode', 'seats', 'debates']) {
    if (!(key in ledger)) {
      fail('$', `missing required key '${key}'`)
    }
  }
  const protocol = ledger.protocol ?? 'v2'
  checkEnum('$.protocol', ledger.protocol, ['v2', 'v3'])
  checkString('$.slug', ledger.slug)
  checkString('$.problem', ledger.problem)
  checkEnum('$.mode', ledger.mode, MODES)
  checkString('$.run', ledger.run)
  checkString('$.family_note', ledger.family_note)
  checkString('$.protocol_note', ledger.protocol_note)
  if (ledger.store !== undefined) {
    if (checkObject('$.store', ledger.store, { required: [], allowed: ['deliberation', 'slug'] })) {
      checkString('$.store.deliberation', ledger.store.deliberation)
      checkString('$.store.slug', ledger.store.slug)
    }
  }

  const seats = checkArray('$.seats', ledger.seats)
  if (seats && seats.length < 2) {
    fail('$.seats', `expected at least 2 seats, got ${seats.length}`)
  }
  seats?.forEach((seat, i) => checkSeat(`$.seats[${i}]`, seat))

  const debates = checkArray('$.debates', ledger.debates)
  debates?.forEach((debate, d) => {
    const dp = `$.debates[${d}]`
    if (!isObject(debate)) {
      fail(dp, 'expected an object')
      return
    }
    for (const key of ['debate', 'problem', 'proposals']) {
      if (!(key in debate)) {
        fail(dp, `missing required key '${key}'`)
      }
    }
    checkInteger(`${dp}.debate`, debate.debate, 1)
    checkString(`${dp}.problem`, debate.problem)
    const proposals = checkArray(`${dp}.proposals`, debate.proposals)
    proposals?.forEach((proposal, i) => checkProposal(`${dp}.proposals[${i}]`, proposal))
    const rounds = checkArray(`${dp}.rounds`, debate.rounds)
    rounds?.forEach((round, i) => checkRound(`${dp}.rounds[${i}]`, round, protocol))
    checkResolution(`${dp}.resolution`, debate.resolution)
  })
}

const file = process.argv[2]
if (!file) {
  console.error('usage: node validate-ledger.mjs <ledger.json>')
  process.exit(2)
}

let ledger
try {
  ledger = JSON.parse(readFileSync(file, 'utf8'))
} catch (error) {
  console.error(`${file}: could not read or parse — ${error.message}`)
  process.exit(1)
}

validate(ledger)

if (problems.length > 0) {
  console.error(`${file}: ${problems.length} problem${problems.length === 1 ? '' : 's'}`)
  for (const problem of problems) {
    console.error(`  ${problem}`)
  }
  process.exit(1)
}

console.log(`${file}: ok (protocol ${ledger.protocol ?? 'v2'}, ${ledger.seats?.length ?? 0} seats)`)
