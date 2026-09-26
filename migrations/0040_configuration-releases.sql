-- Versioned configuration releases: the referral form and its preference rules
-- become data the charity publishes, rather than files shipped with the client.
-- `INITIAL_SPEC1.txt`, `#referral`.
--
-- The generated part (the two tables, the partial unique index, and
-- `referrals.form_id`) is drizzle-kit's output unchanged. `referrals` is NOT
-- rebuilt: SQLite adds a nullable column carrying a REFERENCES clause in place,
-- which is why `form_id` is nullable at all. See `0008`'s header for why a
-- rebuild of `referrals` is to be avoided.
--
-- Hand-written below the generated part:
--
-- 1. The baseline release. Its questionnaire and rules are, byte for byte, the
--    client's `src/features/referrals/referral-form.config.json` and
--    `src/features/pick-lists/preference-rules.config.json` at foodbankclient
--    commit 4ed8d18 — the form and rules every existing referral was filled in
--    under. The hashes are SHA-256 of those bytes. Its id is fixed so every
--    environment shares it.
-- 2. The backfill of every existing referral to it. It must happen here, while
--    the baseline is the only release there is: an existing referral must
--    never be linked to a later edited release just because that one is in use
--    when a backfill runs.
CREATE TABLE `configuration_release_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`release_id` text NOT NULL,
	`action` text NOT NULL,
	`occurred_at` text NOT NULL,
	`actor_user_id` text NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `configuration_releases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "configuration_release_publications_action_valid" CHECK("configuration_release_publications"."action" IN ('publish', 'rollback'))
);
--> statement-breakpoint
CREATE INDEX `idx_configuration_release_publications_release` ON `configuration_release_publications` (`release_id`);--> statement-breakpoint
CREATE TABLE `configuration_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`questionnaire_json` text NOT NULL,
	`rules_json` text NOT NULL,
	`questionnaire_hash` text NOT NULL,
	`rules_hash` text NOT NULL,
	`generation_id` text NOT NULL,
	`generated_at` text NOT NULL,
	`source_workbook_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by_user_id` text,
	`published_at` text,
	`published_by_user_id` text,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`published_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "configuration_releases_status_valid" CHECK("configuration_releases"."status" IN ('draft', 'published', 'superseded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_configuration_releases_one_published` ON `configuration_releases` (`status`) WHERE "configuration_releases"."status" = 'published';--> statement-breakpoint
CREATE INDEX `idx_configuration_releases_created_at` ON `configuration_releases` (`created_at`);--> statement-breakpoint
ALTER TABLE `referrals` ADD `form_id` text REFERENCES configuration_releases(id);--> statement-breakpoint
CREATE INDEX `idx_referrals_form` ON `referrals` (`form_id`);--> statement-breakpoint
INSERT INTO `configuration_releases` (`id`, `questionnaire_json`, `rules_json`, `questionnaire_hash`, `rules_hash`, `generation_id`, `generated_at`, `source_workbook_id`, `status`, `created_at`, `created_by_user_id`, `published_at`, `published_by_user_id`) VALUES ('6f1d2c3a-8b4e-4f5a-9c7d-0e1f2a3b4c40', '{
  "version": 4,
  "pages": [
    {
      "pageNum": 1,
      "pageTitle": "Referrer and client details",
      "questions": [
        {
          "questionNum": 1,
          "questionKey": "referrerName",
          "questionTitle": "Referrer''s name",
          "required": true,
          "keyField": "referrerName"
        },
        {
          "questionNum": 2,
          "questionKey": "referrerEmail",
          "questionTitle": "Referrer''s email address",
          "required": true,
          "helpText": "Checked as you type. If we do not recognise it, the referral still goes through, but an administrator has to approve it before the client is booked in.",
          "keyField": "referrerEmail"
        },
        {
          "questionNum": 3,
          "questionKey": "referrerOrganisation",
          "questionTitle": "Referrer''s organisation",
          "required": true,
          "helpText": "Choose yours from the list. If it is not there, choose the last option and type it in.",
          "keyField": "referrerOrganisation"
        },
        {
          "questionNum": 4,
          "questionKey": "referrerPhone",
          "questionTitle": "Referrer''s contact number",
          "required": true,
          "keyField": "referrerPhone"
        },
        {
          "questionNum": 5,
          "questionKey": "refereeFirstName",
          "questionTitle": "Client''s first name",
          "required": true,
          "forFuelTeam": true,
          "forListenerSheet": true,
          "keyField": "refereeFirstName"
        },
        {
          "questionNum": 6,
          "questionKey": "refereeSurname",
          "questionTitle": "Client''s surname",
          "required": true,
          "forFuelTeam": true,
          "forListenerSheet": true,
          "keyField": "refereeSurname"
        },
        {
          "questionNum": 7,
          "questionKey": "refereeDateOfBirth",
          "questionTitle": "Client''s date of birth",
          "required": true,
          "forFuelTeam": true,
          "keyField": "refereeDateOfBirth"
        },
        {
          "questionNum": 8,
          "questionKey": "gender",
          "questionTitle": "Client''s gender",
          "required": true,
          "preference": false,
          "validation": {
            "type": "CheckBox",
            "answerMin": 1,
            "answerMax": 1
          },
          "answers": [
            "Male",
            "Female",
            "Other"
          ]
        },
        {
          "questionNum": 9,
          "questionKey": "ethnicity",
          "questionTitle": "Ethnicity",
          "required": true,
          "preference": false,
          "validation": {
            "type": "CheckBox",
            "answerMin": 1,
            "answerMax": 1
          },
          "answers": [
            "White -British",
            "White - Irish",
            "White - Gypsy or Irish Traveller",
            "White - Roma",
            "White Other (Please specify)",
            "Mixed - White and Black Caribbean",
            "Mixed - White and Black African",
            "Mixed - White and Asian",
            "Mixed - Other (Please specify",
            "Asian - Indian",
            "Asian - Pakistani",
            "Asian - Bangladeshi",
            "Asian - Chinese",
            "Black - African",
            "Black - Caribbean",
            "Arab - Middle Eastern (Please specify)",
            "Arab - North African (Please specify)",
            "Other - (Please Specify)"
          ]
        },
        {
          "questionNum": 10,
          "questionKey": "languages",
          "questionTitle": "Mother tongue (if not English) and level of spoken English",
          "required": false,
          "preference": false,
          "validation": {
            "type": "String",
            "maxLength": 500
          }
        },
        {
          "questionNum": 11,
          "questionKey": "refereeEmail",
          "questionTitle": "Client''s email",
          "required": false,
          "forFuelTeam": true,
          "preference": false,
          "validation": {
            "type": "String",
            "maxLength": 500
          }
        },
        {
          "questionNum": 12,
          "questionKey": "refereePhone",
          "questionTitle": "Client''s contact number",
          "required": true,
          "forFuelTeam": true,
          "keyField": "refereePhone"
        },
        {
          "questionNum": 13,
          "questionKey": "refereeAddress",
          "questionTitle": "First line of address",
          "required": true,
          "forFuelTeam": true,
          "keyField": "refereeAddress"
        },
        {
          "questionNum": 14,
          "questionKey": "refereePostcode",
          "questionTitle": "Client''s postcode",
          "required": true,
          "forFuelTeam": true,
          "keyField": "refereePostcode"
        },
        {
          "questionNum": 15,
          "questionKey": "Household Components",
          "questionTitle": "Household Composition\nPlease type relevant number in household for each gender and related age group",
          "required": true,
          "preference": false,
          "validation": {
            "type": "HouseholdComposition"
          }
        },
        {
          "questionNum": 16,
          "questionKey": "source of income",
          "questionTitle": "What is your main source of income",
          "required": true,
          "preference": false,
          "validation": {
            "type": "CheckBox",
            "answerMin": 1,
            "answerMax": 1
          },
          "answers": [
            "Employment - full time",
            "Employment - part time",
            "Employment - 0 hours/agency",
            "Benefits",
            "Asylum seeker - income",
            "Student",
            "No income",
            "Pension",
            "Other"
          ]
        },
        {
          "questionNum": 17,
          "questionKey": "reasonId",
          "questionTitle": "Main cause of crisis",
          "required": true,
          "forListenerSheet": true,
          "keyField": "reasonId"
        },
        {
          "questionNum": 18,
          "questionKey": "reasonAdditional",
          "questionTitle": "Additional information about crisis",
          "required": false,
          "forListenerSheet": true,
          "preference": false,
          "validation": {
            "type": "String",
            "maxLength": 500
          }
        },
        {
          "questionNum": 19,
          "questionKey": "Secondary",
          "questionTitle": "Secondary cause of crisis",
          "required": false,
          "forListenerSheet": true,
          "preference": false,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1,
            "optionsFrom": "referralReasons",
            "maxAnswerLength": 200
          }
        },
        {
          "questionNum": 20,
          "questionKey": "sessionId",
          "questionTitle": "Session date",
          "required": true,
          "keyField": "sessionId"
        },
        {
          "questionNum": 21,
          "questionKey": "Collection method",
          "questionTitle": "How will the parcel be collected",
          "required": true,
          "preference": false,
          "validation": {
            "type": "CheckBox",
            "answerMin": 1,
            "answerMax": 1
          },
          "answers": [
            "Car",
            "Public Transport",
            "On Foot",
            "Referrer will collect",
            "Delivery Requested"
          ]
        },
        {
          "questionNum": 22,
          "questionTitle": "Delivery is restricted to people who are housebound for medical reasons, or do not have any family or friends who can help them collect the parcel. Please note that single person parcels are small enough to be collected on foot/by public transport",
          "answerFormat": "No Answer",
          "enabledWhen": {
            "questionKey": "Collection method",
            "hasAnswer": "Delivery Requested"
          }
        },
        {
          "questionNum": 23,
          "questionTitle": "$deliveryTime",
          "answerFormat": "No Answer",
          "enabledWhen": {
            "questionKey": "Collection method",
            "hasAnswer": "Delivery Requested"
          }
        },
        {
          "questionNum": 24,
          "questionKey": "deliveryConfirm",
          "questionTitle": "Please confirm both of these",
          "required": true,
          "enabledWhen": {
            "questionKey": "Collection method",
            "hasAnswer": "Delivery Requested"
          },
          "preference": false,
          "validation": {
            "type": "CheckBox",
            "answerMin": 2,
            "answerMax": 2
          },
          "answers": [
            "The client meets the criteria for delivery",
            "The client will be in at the above time"
          ]
        }
      ]
    },
    {
      "pageNum": 2,
      "pageTitle": "Food Preference",
      "questions": [
        {
          "questionNum": 1,
          "questionKey": "Allergies",
          "questionTitle": "Are there any members of the household who cannot eat certain foods?  Specify food group and number of people impacted (eg. gluten, dairy, vegetarian, Halal, etc)",
          "required": false,
          "pickListInformation": "Yes",
          "preference": true,
          "validation": {
            "type": "String",
            "maxLength": 500
          }
        },
        {
          "questionNum": 2,
          "questionKey": "Cooking Facility",
          "questionTitle": "What cooking facility does the client have available?",
          "required": true,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 1,
            "answerMax": 4
          },
          "answers": [
            "Oven",
            "Hob",
            "Microwave",
            "Kettle",
            "None"
          ]
        },
        {
          "questionNum": 3,
          "questionKey": "Pasta/Rice",
          "questionTitle": "Would they prefer pasta or rice?",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Pasta",
            "Rice",
            "Both"
          ],
          "default": [
            "Both"
          ]
        },
        {
          "questionNum": 4,
          "questionKey": "Sugar/Flour",
          "questionTitle": "Would they like flour or sugar?",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Sugar",
            "Flour"
          ]
        },
        {
          "questionNum": 5,
          "questionKey": "Spread",
          "questionTitle": "What would be their preference of spread? (Please only select 1 spread if 1-2 people and 2 spreads if 3 or more in household.)",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 2
          },
          "answers": [
            "Jam",
            "Marmalade",
            "Honey",
            "Peanut butter",
            "Chocolate spread"
          ],
          "default": [
            "Jam"
          ]
        },
        {
          "questionNum": 6,
          "questionKey": "PulsesYes",
          "questionTitle": "Would they like tinned pulses? (If they have a preference please say which.)",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Yes"
          ]
        },
        {
          "questionNum": 7,
          "questionKey": "Pulses",
          "questionTitle": "(If they have a preference for beans please say which.)",
          "required": false,
          "enabledWhen": {
            "questionKey": "PulsesYes",
            "hasAnswer": "Yes"
          },
          "pickListInformation": "Yes",
          "preference": true,
          "validation": {
            "type": "String",
            "maxLength": 500
          }
        },
        {
          "questionNum": 8,
          "questionKey": "Tea/Coffee",
          "questionTitle": "Would they prefer tea, coffee or hot chocolate?",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 2
          },
          "answers": [
            "Tea",
            "Decaf Tea",
            "Coffee",
            "Decaf Coffee",
            "Hot Chocolate"
          ],
          "default": [
            "Tea",
            "Coffee"
          ]
        },
        {
          "questionNum": 9,
          "questionKey": "Porridge",
          "questionTitle": "Would they like porridge oats?",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Yes"
          ],
          "default": [
            "Yes"
          ]
        },
        {
          "questionNum": 10,
          "questionKey": "Eggs",
          "questionTitle": "Would they like eggs?",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Yes"
          ],
          "default": [
            "Yes"
          ]
        }
      ]
    },
    {
      "pageNum": 3,
      "pageTitle": "Toiletries and baby items",
      "questions": [
        {
          "questionNum": 1,
          "questionKey": "Tampons",
          "questionTitle": "Do they need tampons?  For how many people",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "1",
            "2",
            "3",
            "4",
            "5"
          ]
        },
        {
          "questionNum": 2,
          "questionKey": "Sanitary Pads",
          "questionTitle": "Do they need Sanitary Pads?  For how many people",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "1",
            "2",
            "3",
            "4",
            "5"
          ]
        },
        {
          "questionNum": 3,
          "questionKey": "Incontinence products",
          "questionTitle": "Do they need incontinence products? For how many people?",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "1",
            "2",
            "3",
            "4"
          ]
        },
        {
          "questionNum": 4,
          "questionKey": "Toiletries",
          "questionTitle": "Please select which THREE toiletries they require most. We give everyone toilet roll.",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 3
          },
          "answers": [
            "Shower gel",
            "Deodorant",
            "Shampoo & Conditioner",
            "Toothpaste",
            "Toothbrush",
            "Soap",
            "Razors",
            "Shaving foam"
          ],
          "default": [
            "Shower gel",
            "Deodorant",
            "Shampoo & Conditioner"
          ]
        },
        {
          "questionNum": 5,
          "questionKey": "Toothpaste",
          "questionTitle": "Do they also need child''s toothpaste",
          "required": false,
          "enabledWhen": {
            "questionKey": "Toiletries",
            "hasAnswer": "Toothpaste"
          },
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Yes"
          ]
        },
        {
          "questionNum": 6,
          "questionKey": "Toothbrush",
          "questionTitle": "How many adult toothbrushes do they need?",
          "required": false,
          "enabledWhen": {
            "questionKey": "Toiletries",
            "hasAnswer": "Toothbrush"
          },
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "5",
            "4",
            "3",
            "2",
            "1"
          ]
        },
        {
          "questionNum": 7,
          "questionKey": "Tbrush-child",
          "questionTitle": "How many child (0-6) toothbrushes do they need?",
          "required": false,
          "enabledWhen": {
            "questionKey": "Toiletries",
            "hasAnswer": "Toothbrush"
          },
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "5",
            "4",
            "3",
            "2",
            "1"
          ]
        },
        {
          "questionNum": 8,
          "questionKey": "Nappies",
          "questionTitle": "Do they require nappies?",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 3
          },
          "answers": [
            "Nappies - size 1",
            "Nappies - size 2",
            "Nappies - size 3",
            "Nappies - size 4",
            "Nappies - size 5",
            "Nappies - size 6",
            "Nappies - size 7",
            "Nappies - size 8",
            "Pyjama pants age 4-7",
            "Pyjama pants age 8-12"
          ]
        },
        {
          "questionNum": 9,
          "questionKey": "Baby Food",
          "questionTitle": "Do they require baby food?",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Yes"
          ]
        },
        {
          "questionNum": 10,
          "questionKey": "Baby Milk",
          "questionTitle": "Do they require baby milk?",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Baby formula - Stage 1",
            "Baby formula - Stage 2"
          ]
        }
      ]
    },
    {
      "pageNum": 4,
      "pageTitle": "Household Items",
      "questions": [
        {
          "questionNum": 1,
          "questionKey": "Household",
          "questionTitle": "Please select which THREE household items they require most.",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 3
          },
          "answers": [
            "Laundry detergent",
            "Spray cleaner",
            "Washing up liquid",
            "Toilet cleaner/bleach",
            "Cloths & Sponges"
          ],
          "default": [
            "Laundry detergent",
            "Spray cleaner",
            "Washing up liquid"
          ]
        }
      ]
    },
    {
      "pageNum": 5,
      "pageTitle": "Pets",
      "questions": [
        {
          "questionNum": 1,
          "questionKey": "Cat food",
          "questionTitle": "Do they need cat food",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Cat food - dry",
            "Cat food - wet",
            "Both"
          ]
        },
        {
          "questionNum": 2,
          "questionKey": "Dog food",
          "questionTitle": "Do they need dog food",
          "required": false,
          "preference": true,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Dog food - dry",
            "Dog food - wet",
            "Both"
          ]
        }
      ]
    },
    {
      "pageNum": 6,
      "pageTitle": "Gas and electricity",
      "questions": [
        {
          "questionNum": 1,
          "questionKey": "needsFuelHelp",
          "questionTitle": "Does the client need help with Energy costs?",
          "required": false,
          "forListenerSheet": true,
          "keyField": "needsFuelHelp"
        },
        {
          "questionNum": 2,
          "questionKey": "FuelPension",
          "questionTitle": "Are there people in the household over state pension age",
          "required": false,
          "enabledWhen": {
            "questionKey": "needsFuelHelp",
            "hasAnswer": "Yes"
          },
          "forFuelTeam": true,
          "preference": false,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Yes"
          ]
        },
        {
          "questionNum": 3,
          "questionKey": "Electricity crisis",
          "questionTitle": "Electricity - If the client is on a prepayment meter and in fuel crisis (will run out in 5 days or less and does not have funds to top up), specify Electricity provider",
          "required": false,
          "enabledWhen": {
            "questionKey": "needsFuelHelp",
            "hasAnswer": "Yes"
          },
          "forFuelTeam": true,
          "preference": false,
          "validation": {
            "type": "String",
            "maxLength": 500
          }
        },
        {
          "questionNum": 4,
          "questionKey": "Electricity Smart",
          "questionTitle": "Are they on a smart meter for electricity?",
          "required": false,
          "enabledWhen": {
            "questionKey": "needsFuelHelp",
            "hasAnswer": "Yes"
          },
          "forFuelTeam": true,
          "preference": false,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Yes"
          ]
        },
        {
          "questionNum": 5,
          "questionKey": "Gas crisis",
          "questionTitle": "Gas - If the client is on a pre-payment meter and in fuel crisis (will run out in 5 days or less) and does not have funds to top up, specify Gas provider",
          "required": false,
          "enabledWhen": {
            "questionKey": "needsFuelHelp",
            "hasAnswer": "Yes"
          },
          "forFuelTeam": true,
          "preference": false,
          "validation": {
            "type": "String",
            "maxLength": 500
          }
        },
        {
          "questionNum": 6,
          "questionKey": "Gas Smart",
          "questionTitle": "Are they on a smart meter for gas?",
          "required": false,
          "enabledWhen": {
            "questionKey": "needsFuelHelp",
            "hasAnswer": "Yes"
          },
          "forFuelTeam": true,
          "preference": false,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Yes"
          ]
        },
        {
          "questionNum": 7,
          "questionKey": "Electricity debt",
          "questionTitle": "If they are billed for their electricity (not on a pre-payment meter), are they in fuel debt for electricity?",
          "required": false,
          "enabledWhen": {
            "questionKey": "needsFuelHelp",
            "hasAnswer": "Yes"
          },
          "forFuelTeam": true,
          "preference": false,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Yes"
          ]
        },
        {
          "questionNum": 8,
          "questionKey": "Gas debt",
          "questionTitle": "If they are billed for their gas (not on a pre-payment meter), are they in fuel debt for gas?",
          "required": false,
          "enabledWhen": {
            "questionKey": "needsFuelHelp",
            "hasAnswer": "Yes"
          },
          "forFuelTeam": true,
          "preference": false,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Yes"
          ]
        },
        {
          "questionNum": 9,
          "questionKey": "Permission",
          "questionTitle": "Do you give permission to share details with \"Energy Manage\" and/or \"The Fuel Bank Foundation\" who work in partnership with the foodbank to support our clients?",
          "required": false,
          "enabledWhen": {
            "questionKey": "needsFuelHelp",
            "hasAnswer": "Yes"
          },
          "forFuelTeam": true,
          "preference": false,
          "validation": {
            "type": "CheckBox",
            "answerMin": 0,
            "answerMax": 1
          },
          "answers": [
            "Yes"
          ]
        }
      ]
    },
    {
      "pageNum": 7,
      "pageTitle": "Anything else",
      "questions": [
        {
          "questionNum": 1,
          "questionKey": "Other",
          "questionTitle": "Any additional information?",
          "required": false,
          "preference": true,
          "validation": {
            "type": "String",
            "maxLength": 500
          }
        }
      ]
    }
  ]
}
', '{
  "rules": [
    {
      "when": {
        "key": "Pasta/Rice",
        "hasAnswer": "Pasta"
      },
      "cases": [
        {
          "familySize": {
            "people": "total",
            "atLeast": 8
          },
          "set": [
            {
              "stock": "Pasta",
              "quantity": 7
            },
            {
              "stock": "Pasta sauce",
              "quantity": 7
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 5
          },
          "set": [
            {
              "stock": "Pasta",
              "quantity": 6
            },
            {
              "stock": "Pasta sauce",
              "quantity": 6
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 4
          },
          "set": [
            {
              "stock": "Pasta",
              "quantity": 5
            },
            {
              "stock": "Pasta sauce",
              "quantity": 5
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 3
          },
          "set": [
            {
              "stock": "Pasta",
              "quantity": 4
            },
            {
              "stock": "Pasta sauce",
              "quantity": 4
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 2
          },
          "set": [
            {
              "stock": "Pasta",
              "quantity": 2
            },
            {
              "stock": "Pasta sauce",
              "quantity": 3
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Pasta",
            "quantity": 1
          },
          {
            "stock": "Pasta sauce",
            "quantity": 2
          }
        ]
      }
    },
    {
      "when": {
        "key": "Pasta/Rice",
        "hasAnswer": "Rice"
      },
      "cases": [
        {
          "familySize": {
            "people": "total",
            "atLeast": 8
          },
          "set": [
            {
              "stock": "Rice",
              "quantity": 7
            },
            {
              "stock": "Curry sauce",
              "quantity": 7
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 5
          },
          "set": [
            {
              "stock": "Rice",
              "quantity": 6
            },
            {
              "stock": "Curry sauce",
              "quantity": 6
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 4
          },
          "set": [
            {
              "stock": "Rice",
              "quantity": 5
            },
            {
              "stock": "Curry sauce",
              "quantity": 5
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 3
          },
          "set": [
            {
              "stock": "Rice",
              "quantity": 4
            },
            {
              "stock": "Curry sauce",
              "quantity": 4
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 2
          },
          "set": [
            {
              "stock": "Rice",
              "quantity": 2
            },
            {
              "stock": "Curry sauce",
              "quantity": 3
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Rice",
            "quantity": 1
          },
          {
            "stock": "Curry sauce",
            "quantity": 2
          }
        ]
      }
    },
    {
      "when": {
        "key": "Pasta/Rice",
        "hasAnswer": "Both"
      },
      "cases": [
        {
          "familySize": {
            "people": "total",
            "atLeast": 8
          },
          "set": [
            {
              "stock": "Pasta",
              "quantity": 4
            },
            {
              "stock": "Pasta sauce",
              "quantity": 5
            },
            {
              "stock": "Rice",
              "quantity": 3
            },
            {
              "stock": "Curry sauce",
              "quantity": 4
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 5
          },
          "set": [
            {
              "stock": "Pasta",
              "quantity": 3
            },
            {
              "stock": "Pasta sauce",
              "quantity": 4
            },
            {
              "stock": "Rice",
              "quantity": 3
            },
            {
              "stock": "Curry sauce",
              "quantity": 3
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 4
          },
          "set": [
            {
              "stock": "Pasta",
              "quantity": 3
            },
            {
              "stock": "Pasta sauce",
              "quantity": 3
            },
            {
              "stock": "Rice",
              "quantity": 2
            },
            {
              "stock": "Curry sauce",
              "quantity": 2
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 3
          },
          "set": [
            {
              "stock": "Pasta",
              "quantity": 2
            },
            {
              "stock": "Pasta sauce",
              "quantity": 2
            },
            {
              "stock": "Rice",
              "quantity": 2
            },
            {
              "stock": "Curry sauce",
              "quantity": 2
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 2
          },
          "set": [
            {
              "stock": "Pasta",
              "quantity": 2
            },
            {
              "stock": "Pasta sauce",
              "quantity": 2
            },
            {
              "stock": "Rice",
              "quantity": 1
            },
            {
              "stock": "Curry sauce",
              "quantity": 1
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Pasta",
            "quantity": 1
          },
          {
            "stock": "Pasta sauce",
            "quantity": 1
          },
          {
            "stock": "Rice",
            "quantity": 1
          },
          {
            "stock": "Curry sauce",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Sugar/Flour"
      },
      "cases": [
        {
          "familySize": {
            "people": "adults",
            "atLeast": 3
          },
          "set": [
            {
              "stock": "$selectedAnswer",
              "quantity": 2
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "$selectedAnswer",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Spread"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "$selectedAnswer",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "PulsesYes"
      },
      "cases": [
        {
          "familySize": {
            "people": "total",
            "atLeast": 8
          },
          "set": [
            {
              "stock": "Pulses",
              "quantity": 5
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 5
          },
          "set": [
            {
              "stock": "Pulses",
              "quantity": 4
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 4
          },
          "set": [
            {
              "stock": "Pulses",
              "quantity": 3
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 3
          },
          "set": [
            {
              "stock": "Pulses",
              "quantity": 2
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 2
          },
          "set": [
            {
              "stock": "Pulses",
              "quantity": 2
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Pulses",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Tea/Coffee",
        "hasAnswer": "Tea"
      },
      "cases": [
        {
          "familySize": {
            "people": "adults",
            "atLeast": 3
          },
          "set": [
            {
              "stock": "Tea - 160 bags",
              "quantity": 1
            }
          ]
        },
        {
          "familySize": {
            "people": "adults",
            "atLeast": 2
          },
          "set": [
            {
              "stock": "Tea - 80 bags",
              "quantity": 1
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Tea - 40 bags",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Tea/Coffee",
        "hasAnswer": "Decaf Tea"
      },
      "cases": [
        {
          "familySize": {
            "people": "adults",
            "atLeast": 3
          },
          "set": [
            {
              "stock": "Decaf Tea - 40 bags",
              "quantity": 3
            }
          ]
        },
        {
          "familySize": {
            "people": "adults",
            "atLeast": 2
          },
          "set": [
            {
              "stock": "Decaf Tea - 40 bags",
              "quantity": 2
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Decaf Tea - 40 bags",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Tea/Coffee",
        "hasAnswer": "Coffee"
      },
      "cases": [
        {
          "familySize": {
            "people": "adults",
            "atLeast": 3
          },
          "set": [
            {
              "stock": "Coffee - large",
              "quantity": 1
            }
          ]
        },
        {
          "familySize": {
            "people": "adults",
            "atLeast": 2
          },
          "set": [
            {
              "stock": "Coffee - med",
              "quantity": 1
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Coffee - small",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Tea/Coffee",
        "hasAnswer": "Decaf Coffee"
      },
      "cases": [
        {
          "familySize": {
            "people": "adults",
            "atLeast": 3
          },
          "set": [
            {
              "stock": "Decaf Coffee",
              "quantity": 2
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Decaf Coffee",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Tea/Coffee"
      },
      "cases": [
        {
          "familySize": {
            "people": "adults",
            "atLeast": 4
          },
          "set": [
            {
              "stock": "$selectedAnswer",
              "quantity": 2
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "$selectedAnswer",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Porridge",
        "hasAnswer": "Yes"
      },
      "cases": [
        {
          "familySize": {
            "people": "total",
            "atLeast": 5
          },
          "set": [
            {
              "stock": "Porridge",
              "quantity": 2
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Porridge",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Eggs",
        "hasAnswer": "Yes"
      },
      "cases": [
        {
          "familySize": {
            "people": "total",
            "atLeast": 8
          },
          "set": [
            {
              "stock": "Egg boxes",
              "quantity": 3
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 3
          },
          "set": [
            {
              "stock": "Egg boxes",
              "quantity": 2
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Egg boxes",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Tampons",
        "hasAnswer": "1"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Tampons",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Tampons",
        "hasAnswer": "2"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Tampons",
            "quantity": 2
          }
        ]
      }
    },
    {
      "when": {
        "key": "Tampons",
        "hasAnswer": "3"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Tampons",
            "quantity": 3
          }
        ]
      }
    },
    {
      "when": {
        "key": "Tampons",
        "hasAnswer": "4"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Tampons",
            "quantity": 4
          }
        ]
      }
    },
    {
      "when": {
        "key": "Tampons",
        "hasAnswer": "5"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Tampons",
            "quantity": 5
          }
        ]
      }
    },
    {
      "when": {
        "key": "Sanitary Pads",
        "hasAnswer": "1"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Sanitary pads",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Sanitary Pads",
        "hasAnswer": "2"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Sanitary pads",
            "quantity": 2
          }
        ]
      }
    },
    {
      "when": {
        "key": "Sanitary Pads",
        "hasAnswer": "3"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Sanitary pads",
            "quantity": 3
          }
        ]
      }
    },
    {
      "when": {
        "key": "Sanitary Pads",
        "hasAnswer": "4"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Sanitary pads",
            "quantity": 4
          }
        ]
      }
    },
    {
      "when": {
        "key": "Sanitary Pads",
        "hasAnswer": "5"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Sanitary pads",
            "quantity": 5
          }
        ]
      }
    },
    {
      "when": {
        "key": "Incontinence products",
        "hasAnswer": "1"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Incontinence products",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Incontinence products",
        "hasAnswer": "2"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Incontinence products",
            "quantity": 2
          }
        ]
      }
    },
    {
      "when": {
        "key": "Incontinence products",
        "hasAnswer": "3"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Incontinence products",
            "quantity": 3
          }
        ]
      }
    },
    {
      "when": {
        "key": "Incontinence products",
        "hasAnswer": "4"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Incontinence products",
            "quantity": 4
          }
        ]
      }
    },
    {
      "when": {
        "key": "Toiletries",
        "hasAnswer": "Toothbrush"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "$dummy",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Toiletries",
        "hasAnswer": "Shower gel"
      },
      "cases": [
        {
          "familySize": {
            "people": "total",
            "atLeast": 4
          },
          "set": [
            {
              "stock": "Shower gel",
              "quantity": 2
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Shower gel",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Toiletries",
        "hasAnswer": "Toothpaste"
      },
      "cases": [
        {
          "familySize": {
            "people": "adults",
            "atLeast": 4
          },
          "set": [
            {
              "stock": "Toothpaste - adult",
              "quantity": 2
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Toothpaste - adult",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Toiletries",
        "hasAnswer": "Deodorant"
      },
      "cases": [
        {
          "familySize": {
            "people": "total",
            "atLeast": 4
          },
          "set": [
            {
              "stock": "Deodorant",
              "quantity": 2
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Deodorant",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Toothpaste"
      },
      "cases": [
        {
          "familySize": {
            "people": "children",
            "atLeast": 4
          },
          "set": [
            {
              "stock": "Toothpaste - child",
              "quantity": 2
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Toothpaste - child",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Toothbrush",
        "hasAnswer": "5"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Toothbrush - adult",
            "quantity": 5
          }
        ]
      }
    },
    {
      "when": {
        "key": "Toothbrush",
        "hasAnswer": "4"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Toothbrush - adult",
            "quantity": 4
          }
        ]
      }
    },
    {
      "when": {
        "key": "Toothbrush",
        "hasAnswer": "3"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Toothbrush - adult",
            "quantity": 3
          }
        ]
      }
    },
    {
      "when": {
        "key": "Toothbrush",
        "hasAnswer": "2"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Toothbrush - adult",
            "quantity": 2
          }
        ]
      }
    },
    {
      "when": {
        "key": "Toothbrush",
        "hasAnswer": "1"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Toothbrush - adult",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Tbrush-child",
        "hasAnswer": "5"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Toothbrush - child",
            "quantity": 5
          }
        ]
      }
    },
    {
      "when": {
        "key": "Tbrush-child",
        "hasAnswer": "4"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Toothbrush - child",
            "quantity": 4
          }
        ]
      }
    },
    {
      "when": {
        "key": "Tbrush-child",
        "hasAnswer": "3"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Toothbrush - child",
            "quantity": 3
          }
        ]
      }
    },
    {
      "when": {
        "key": "Tbrush-child",
        "hasAnswer": "2"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Toothbrush - child",
            "quantity": 2
          }
        ]
      }
    },
    {
      "when": {
        "key": "Tbrush-child",
        "hasAnswer": "1"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Toothbrush - child",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Toiletries",
        "hasAnswer": "Toothbrush"
      },
      "cases": [
        {
          "familySize": {
            "people": "adults",
            "atLeast": 4
          },
          "set": [
            {
              "stock": "Toothbrush - adult",
              "quantity": 4
            }
          ]
        },
        {
          "familySize": {
            "people": "adults",
            "atLeast": 3
          },
          "set": [
            {
              "stock": "Toothbrush - adult",
              "quantity": 3
            }
          ]
        },
        {
          "familySize": {
            "people": "adults",
            "atLeast": 2
          },
          "set": [
            {
              "stock": "Toothbrush - adult",
              "quantity": 2
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Toothbrush - adult",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Toiletries",
        "hasAnswer": "Toothbrush"
      },
      "cases": [
        {
          "familySize": {
            "people": "children",
            "atLeast": 4
          },
          "set": [
            {
              "stock": "Toothbrush - child",
              "quantity": 4
            }
          ]
        },
        {
          "familySize": {
            "people": "children",
            "atLeast": 3
          },
          "set": [
            {
              "stock": "Toothbrush - child",
              "quantity": 3
            }
          ]
        },
        {
          "familySize": {
            "people": "children",
            "atLeast": 2
          },
          "set": [
            {
              "stock": "Toothbrush - child",
              "quantity": 2
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Toothbrush - child",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Toiletries",
        "hasAnswer": "Shampoo & Conditioner"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Shampoo",
            "quantity": 1
          },
          {
            "stock": "Conditioner",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Toiletries"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "$selectedAnswer",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Nappies"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "$selectedAnswer",
            "quantity": 1
          },
          {
            "stock": "Wipes",
            "quantity": 2
          }
        ]
      }
    },
    {
      "when": {
        "key": "Baby Milk"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "$selectedAnswer",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Household",
        "hasAnswer": "Laundry detergent"
      },
      "cases": [
        {
          "familySize": {
            "people": "total",
            "atLeast": 4
          },
          "set": [
            {
              "stock": "Laundry detergent - lrg",
              "quantity": 1
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Laundry detergent - sm",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Household",
        "hasAnswer": "Cloths & Sponges"
      },
      "cases": [
        {
          "familySize": {
            "people": "total",
            "atLeast": 3
          },
          "set": [
            {
              "stock": "Cloths",
              "quantity": 4
            },
            {
              "stock": "Sponges",
              "quantity": 2
            }
          ]
        },
        {
          "familySize": {
            "people": "total",
            "atLeast": 2
          },
          "set": [
            {
              "stock": "Cloths",
              "quantity": 3
            },
            {
              "stock": "Sponges",
              "quantity": 1
            }
          ]
        }
      ],
      "otherwise": {
        "set": [
          {
            "stock": "Cloths",
            "quantity": 2
          },
          {
            "stock": "Sponges",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Household"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "$selectedAnswer",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Cat food",
        "hasAnswer": "Cat food - dry"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Cat food - dry",
            "quantity": 2
          }
        ]
      }
    },
    {
      "when": {
        "key": "Cat food",
        "hasAnswer": "Cat food - wet"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Cat food - wet",
            "quantity": 2
          }
        ]
      }
    },
    {
      "when": {
        "key": "Cat food",
        "hasAnswer": "Both"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Cat food - dry",
            "quantity": 1
          },
          {
            "stock": "Cat food - wet",
            "quantity": 1
          }
        ]
      }
    },
    {
      "when": {
        "key": "Dog food",
        "hasAnswer": "Dog food - dry"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Dog food - dry",
            "quantity": 2
          }
        ]
      }
    },
    {
      "when": {
        "key": "Dog food",
        "hasAnswer": "Dog food - wet"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Dog food - wet",
            "quantity": 2
          }
        ]
      }
    },
    {
      "when": {
        "key": "Dog food",
        "hasAnswer": "Both"
      },
      "cases": [],
      "otherwise": {
        "set": [
          {
            "stock": "Dog food - dry",
            "quantity": 1
          },
          {
            "stock": "Dog food - wet",
            "quantity": 1
          }
        ]
      }
    }
  ]
}
', '22ad4567d66a8570b02a92cb00c88b5f967e5ae7b60a3b2739e88f2aee937f55', '0eb28ba4e233d4b71773bf597f0fe48ebb95982d56bf9f5bedd2de73e1a35410', 'baseline', '2026-09-25T16:31:22.000Z', 'baseline:foodbankclient@4ed8d18', 'published', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL);--> statement-breakpoint
UPDATE `referrals` SET `form_id` = '6f1d2c3a-8b4e-4f5a-9c7d-0e1f2a3b4c40' WHERE `form_id` IS NULL;
