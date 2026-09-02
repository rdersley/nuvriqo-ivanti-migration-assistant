# v5.7.5 — Forms condition type mapping fix

Fixes the Atlassian Forms validation error:

`Check type 'EqualTo' is not allowed for question type 'ChoiceDropDown'`

## Change
Conditional logic is now mapped according to the controlling Forms question type:

- Choice/dropdown/checkbox-style questions → `SOME_OF`
- Scalar questions → `EQUAL_TO`

The existing required `co.cIds`, advanced `operator/groups/checks` structure,
condition read-back verification, request type reuse, Form population and portal
validation are unchanged.

This is a focused conditional-logic compatibility patch.
