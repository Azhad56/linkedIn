import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../config.js';
import { matchKnownAnswer } from '../qaBank.js';

test('handles salary units and supplied screening questions', () => {
  const original = { ...CONFIG.candidate };
  try {
    Object.assign(CONFIG.candidate, { currentCtcLpa: 17, expectedCtcLpa: 19, dateOfBirth: '25/04/2000', location: 'Delhi, India', totalYearsExperience: 5, noticePeriodDays: 0 });
    assert.equal(matchKnownAnswer('Current CTC in INR', { type: 'number' }), '1700000');
    assert.equal(matchKnownAnswer('Expected CTC in Lacs per annum', { type: 'number' }), '19');
    assert.equal(matchKnownAnswer('How many years of experience do you have in Full stack?', { type: 'radio', options: ['<2 years', '2-5 years', '5-7 years'] }), '2-5 years');
    assert.equal(matchKnownAnswer('Are you currently living in Kerala?', { type: 'radio', options: ['Yes', 'No'] }), 'No');
    assert.equal(matchKnownAnswer('Date of Birth'), '25/04/2000');
    assert.equal(matchKnownAnswer('Did you get a chance to review the JD?', { type: 'radio', options: ['Yes', 'No'] }), 'Yes');
    assert.equal(matchKnownAnswer('Are you currently serving notice period?', { type: 'radio', options: ['Yes', 'No'] }), 'No');
  } finally { Object.assign(CONFIG.candidate, original); }
});
