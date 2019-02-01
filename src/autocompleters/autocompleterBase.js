"use strict";
var $ = require("jquery"),
    utils = require("../utils.js"),
    yutils = require("yasgui-utils"),
    Trie = require("../../lib/trie.js");

/**
 * function which fires after the user selects a completion. this function checks whether we actually need to store this one (if completion is same as current token, don't do anything)
 */
const selectHint = function (yasqe, data, completion) {
    if (completion.text !== yasqe.getTokenAt(yasqe.getCursor()).string) {
        yasqe.replaceRange(completion.text, data.from, data.to);
    }
};
module.exports = function (YASQE, yasqe) {
    const autoComplete = function (fromAutoShow) {
        if (yasqe.somethingSelected()) return;
        const tryHintType = function (completer) {
            if (
                fromAutoShow && // from autoShow, i.e. this gets called each time the editor content changes
                (!completer.autoShow || // autoshow for  this particular type of autocompletion is -not- enabled
                    (!completer.bulk && completer.async)) // async is enabled (don't want to re-do ajax-like request for every editor change)
            ) {
                return false;
            }

            const hintConfig = {
                closeCharacters: /(?=a)b/,
                completeSingle: false
            };
            if (!completer.bulk && completer.async) {
                hintConfig.async = true;
            }
            const wrappedHintCallback = function (yasqe, callback) {
                return getCompletionHintsObject(completer, callback);
            };
            YASQE.showHint(yasqe, wrappedHintCallback, hintConfig);
            return true;
        };
        for (let completerName in completers) {
            if ($.inArray(completerName, yasqe.options.autocompleters) === -1) continue; //this completer is disabled
            if (completers.hasOwnProperty(completerName)) {
                const completer = completers[completerName];
                if (!completer.isValidCompletionPosition) continue; //no way to check whether we are in a valid position

                if (!completer.isValidCompletionPosition()) {
                    //if needed, fire callbacks for when we are -not- in valid completion position
                    if (completer.callbacks && completer.callbacks.invalidPosition) {
                        completer.callbacks.invalidPosition(yasqe, completer);
                    }
                    //not in a valid position, so continue to next completion candidate type
                    continue;
                }
                // run valid position handler, if there is one (if it returns false, stop the autocompletion!)
                if (completer.callbacks && completer.callbacks.validPosition) {
                    if (completer.callbacks.validPosition(yasqe, completer) === false) continue;
                }

                if (tryHintType(completer)) break;
            }
        }
    };
    /**
     *  get our array of suggestions (strings) in the codemirror hint format
     */
    const getSuggestionsAsHintObject = function (suggestions, completer, token) {
        let hintList = [];
        for (let i = 0; i < suggestions.length; i++) {
            let suggestedString = suggestions[i];
            if (completer.postProcessToken) {
                suggestedString = completer.postProcessToken(token, suggestedString);
            }
            hintList.push({
                text: suggestedString,
                displayText: suggestedString,
                hint: selectHint
            });
        }

        let cur = yasqe.getCursor();
        let returnObj = {
            completionToken: token.string,
            list: hintList,
            from: {
                line: cur.line,
                ch: token.start
            },
            to: {
                line: cur.line,
                ch: token.end
            }
        };
        //if we have some autocompletion handlers specified, add these these to the object. Codemirror will take care of firing these
        if (completer.callbacks) {
            for (let callbackName in completer.callbacks) {
                if (completer.callbacks.hasOwnProperty(callbackName) && completer.callbacks[callbackName]) {
                    YASQE.on(returnObj, callbackName, completer.callbacks[callbackName]);
                }
            }
        }
        return returnObj;
    };
    const getCompletionHintsObject = function (completer, callback) {
        let getSuggestionsFromToken = function (partialToken) {
            let stringToAutocomplete = partialToken.autocompletionString || partialToken.string;
            let suggestions = [];
            if (tries[completer.name]) {
                suggestions = tries[completer.name].autoComplete(stringToAutocomplete);
            } else if (typeof completer.get == "function" && completer.async === false) {
                suggestions = completer.get(stringToAutocomplete);
            } else if (typeof completer.get == "object") {
                let partialTokenLength = stringToAutocomplete.length;
                for (let i = 0; i < completer.get.length; i++) {
                    let completion = completer.get[i];
                    if (completion.slice(0, partialTokenLength) === stringToAutocomplete) {
                        suggestions.push(completion);
                    }
                }
            }
            return getSuggestionsAsHintObject(suggestions, completer, partialToken);
        };

        let token = yasqe.getCompleteToken();
        if (completer.preProcessToken) {
            token = completer.preProcessToken(token);
        }

        if (token) {
            // use custom completionhint function, to avoid reaching a loop when the
            // completionhint is the same as the current token
            // regular behaviour would keep changing the codemirror dom, hence
            // constantly calling this callback
            if (!completer.bulk && completer.async) {
                let wrappedCallback = function (suggestions) {
                    callback(getSuggestionsAsHintObject(suggestions, completer, token));
                };
                completer.get(token, wrappedCallback);
            } else {
                return getSuggestionsFromToken(token);
            }
        }
    };
    const completionNotifications = {};
    const completers = {};
    const tries = {};

    yasqe.on("cursorActivity", function () {
        autoComplete(true);
    });

    yasqe.on("change", function () {
        const needPossibleAdjustment = [];
        for (let notificationName in completionNotifications) {
            if (completionNotifications.hasOwnProperty(notificationName) &&
                completionNotifications[notificationName].is(":visible")) {
                needPossibleAdjustment.push(completionNotifications[notificationName]);
            }
        }
        if (needPossibleAdjustment.length > 0) {
            //position completion notifications
            const scrollBar = $(yasqe.getWrapperElement()).find(".CodeMirror-vscrollbar");
            let offset = 0;
            if (scrollBar.is(":visible")) {
                offset = scrollBar.outerWidth();
            }
            needPossibleAdjustment.forEach(function (notification) {
                notification.css("right", offset);
            });
        }
    });

    /**
     * Store bulk completions in memory as trie, and store these in localstorage as well (if enabled)
     *
     * @method doc.storeBulkCompletions
     * @param completer
     * @param completions {array}
     */
    const storeBulkCompletions = function (completer, completions) {
        // store array as trie
        tries[completer.name] = new Trie();
        for (let i = 0; i < completions.length; i++) {
            tries[completer.name].insert(completions[i]);
        }
        // store in localstorage as well
        const storageId = utils.getPersistencyId(yasqe, completer.persistent);
        if (storageId) yutils.storage.set(storageId, completions, "month", yasqe.options.onQuotaExceeded);
    };

    const initCompleter = function (name, completionInit) {
        const completer = (completers[name] = new completionInit(yasqe, name));
        completer.name = name;
        if (completer.bulk) {
            const storeArrayAsBulk = function (suggestions) {
                if (suggestions && suggestions instanceof Array && suggestions.length > 0) {
                    storeBulkCompletions(completer, suggestions);
                }
            };
            if (completer.get instanceof Array) {
                // we don't care whether the completions are already stored in
                // localstorage. just use this one
                storeArrayAsBulk(completer.get);
            } else {
                // if completions are defined in localstorage, use those! (calling the
                // function may come with overhead (e.g. async calls))
                let completionsFromStorage = null;
                const persistencyIdentifier = utils.getPersistencyId(yasqe, completer.persistent);
                if (persistencyIdentifier) completionsFromStorage = yutils.storage.get(persistencyIdentifier);
                if (completionsFromStorage && completionsFromStorage.length > 0) {
                    storeArrayAsBulk(completionsFromStorage);
                    //} else {
                    // nothing in storage. check whether we have a function via which we
                    // can get our prefixes
                    if (completer.get instanceof Function) {
                        if (completer.async) {
                            completer.get(null, storeArrayAsBulk);
                        } else {
                            storeArrayAsBulk(completer.get());
                        }
                    }
                }
            }
        }
    };


    return {
        init: initCompleter,
        completers: completers,
        notifications: {
            getEl: function (completer) {
                return $(completionNotifications[completer.name]);
            },
            show: function (yasqe, completer) {
                //only draw when the user needs to use a keypress to summon autocompletions
                if (completer.hasOwnProperty("autoshow") && !completer.autoshow) {
                    if (!completionNotifications[completer.name])
                        completionNotifications[completer.name] = $("<div class='completionNotification'></div>");
                    completionNotifications[completer.name]
                        .show()
                        .text("Press CTRL - <spacebar> to autocomplete")
                        .appendTo($(yasqe.getWrapperElement()));
                }
            },
            hide: function (yasqe, completer) {
                if (completionNotifications[completer.name]) {
                    completionNotifications[completer.name].hide();
                }
            }
        },
        autoComplete: autoComplete,
        getTrie: function (completer) {
            return typeof completer == "string" ? tries[completer] : tries[completer.name];
        }
    };
};


//
//module.exports = {
//	preprocessPrefixTokenForCompletion: preprocessPrefixTokenForCompletion,
//	postprocessResourceTokenForCompletion: postprocessResourceTokenForCompletion,
//	preprocessResourceTokenForCompletion: preprocessResourceTokenForCompletion,
//	showCompletionNotification: showCompletionNotification,
//	hideCompletionNotification: hideCompletionNotification,
//	autoComplete: autoComplete,
//	autocompleteVariables: autocompleteVariables,
//	fetchFromPrefixCc: fetchFromPrefixCc,
//	fetchFromLov: fetchFromLov,
////	storeBulkCompletions: storeBulkCompletions,
//	loadBulkCompletions: loadBulkCompletions,
//};
