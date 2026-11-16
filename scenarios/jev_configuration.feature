# language: en
# Requirements: PRD FR-78; FR-21, FR-55 superseded clauses; FR-73.
# Source contract: AGENTS.md config and API key sections.
# Normative business specification only; no step definitions or executable runner exist here.
Feature: Diagnostic configuration and judge access stay owner-controlled
  Configuration selects diagnostic preferences and cost display. It never grants
  execution permission. A missing key or unavailable judge is reported and never
  becomes an approval or an ordinary work hold.

  # FR-78; implementation src/config.ts DEFAULT_CONFIG, loadJevConfig
  @jev_configuration_01 @fr_78
  Scenario: Shipped diagnostics use advisory anti-slop and no legacy gates
    Given no user or project configuration file exists
    When the addon loads its configuration
    Then anti-slop mode is advisory
    And no mutation, completion or course-check schedule setting is active
    And the effective configuration contains no enforce mode

  # FR-78; implementation src/config.ts configPaths
  @jev_configuration_02 @fr_78
  Scenario: The project file overrides the user file
    Given the user file sets anti-slop off
    And the project file sets anti-slop advisory
    When the configuration is loaded
    Then the effective anti-slop mode is advisory
    And the user file was read before the project file

  # FR-78; implementation src/config.ts ignored legacy keys
  @jev_configuration_03 @fr_78
  Scenario Outline: Obsolete gate and schedule keys configure nothing
    Given the configuration file contains "<legacy key>"
    When the addon loads its configuration
    Then no execution or completion behavior changes
    And the diagnostic contract remains in force
    Examples:
      | legacy key               |
      | gates.mutation           |
      | gates.completion         |
      | courseCheck.mode         |
      | courseCheck.interval     |

  # FR-78; implementation src/config.ts antiSlopModeValue
  @jev_configuration_04 @fr_78
  Scenario: The removed enforce mode falls back to advisory and is reported
    Given a configuration file sets antiSlop.mode to "enforce"
    When the configuration is loaded
    Then the effective anti-slop mode is advisory
    And the addon reports the file and the invalid key
    And external findings are not described as a delivery gate

  # FR-78; implementation src/config.ts billing parsing
  @jev_configuration_05 @fr_78
  Scenario: Billing values are display preferences, not a live balance
    Given the configuration supplies a balance and per-million token costs
    When /jev-status reports usage
    Then estimated spend is computed from recorded judge tokens and configured costs
    And the configured balance is labelled as configured
    And no live provider balance is queried or claimed

  # FR-78; implementation src/config.ts invalid JSON and value handling
  @jev_configuration_06 @fr_78
  Scenario Outline: An invalid configuration keeps the effective values and names the problem
    Given a configuration file contains "<invalid content>"
    When the configuration is loaded
    Then the values already in force are retained
    And the file and offending key are named
    And configuration problems do not block ordinary work
    Examples:
      | invalid content                         |
      | text that is not valid JSON             |
      | a top level that is not an object       |
      | antiSlop.mode with an unknown value     |
      | billing.balance with a negative number  |
      | billing.inputCostPerMillion as a string |

  # FR-78; implementation src/controller.ts session_start notification
  @jev_configuration_07 @fr_78
  Scenario: Configuration problems are shown when a session starts
    Given the loaded configuration recorded one or more problems
    When a new session starts
    Then the owner is notified of those problems
    And the session continues with the retained effective values

  # FR-78; implementation src/apikey.ts resolveApiKey
  @jev_configuration_08 @fr_78
  Scenario Outline: The key resolves from one owner-supplied source
    Given "<source>" supplies a non-empty key
    When the judge resolves credentials
    Then that value is used as the API key
    And it is not written to configuration, state, diagnostics or logs
    Examples:
      | source                                  |
      | the TYPESAFE_API_KEY environment value  |
      | the JEVI_API_KEY environment value      |
      | the stdout of the configured key command |

  # FR-73, FR-78; implementation src/apikey.ts, src/judge.ts createTypeSafeJudge
  @jev_configuration_09 @fr_73
  Scenario: A missing key produces an unavailable judgment, not an approval
    Given no environment key is set and no key command produces a key
    When the executor calls a Jev tool
    Then the result states that no usable judge decision exists
    And no approval, acceptance or trusted mark is recorded
    And ordinary work and completion remain available under the host's permissions

  # FR-73; implementation src/apikey.ts memoized resolver
  @jev_configuration_10 @fr_73
  Scenario: A credential failure is retryable in the same session
    Given the key command failed on an earlier call
    When a key becomes available before the next Jev call
    Then the next call resolves credentials again
    And the earlier failure did not poison the session

  # FR-73, FR-74; implementation src/judge.ts unavailable and unusable normalization
  @jev_configuration_11 @fr_73
  Scenario Outline: Judge transport and malformed answers are classified without inventing a defect
    Given the judge returns "<failure>"
    When a valid activity consumes the outcome
    Then the result is recorded as unavailable or unusable as appropriate
    And the work is not called defective
    And no effect is authorized by the failed judgment
    Examples:
      | failure                             |
      | a transport or authentication error |
      | a missing required answer           |
      | an answer for an unexpected question|
      | a probability outside zero to one   |
      | an unsupported answer shape         |

  # FR-73, FR-78; implementation src/index.ts, package.json omp.extensions
  @jev_configuration_12 @fr_78
  Scenario: Configuration and extension changes apply to a new host process
    Given the extension is loaded in a running host process
    When an owner edits the configuration or the extension source
    Then the loaded process keeps its current schemas and configuration
    And the changed behavior applies after the host is restarted
    And no reload is claimed without observing the new process
