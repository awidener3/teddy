/**
 * Teddy Templating Engine; Javascript Parser
 * @author Eric Newport (kethinov)
 * @license Creative Commons Attribution 3.0 Unported License http://creativecommons.org/licenses/by/3.0/deed.en_US
 */

/*! @source https://github.com/kethinov/teddy */
/*jshint camelcase: true, curly: true, eqeqeq: false, forin: false, strict: false, trailing: true, evil: true, devel: true, node: true */

(function() {

  // @namespace
  var teddy = {


        /**
         * Teddy core methods
         */

        // compiles a template (removes {! comments !} and unnecessary whitespace)
        compile: function(template, name) {

          // remove templateRoot from template name if necessary
          if (!name) {
            name = template.replace(teddy.params.templateRoot, '');
          }

          // convert filepath into a template string if we're in node
          if (isNode) {
            try {
              template = fs.readFileSync(teddy.params.templateRoot + name, 'utf8');
            }
            catch (e) {
              if (teddy.params.verbosity) {
                console.log('Warning: teddy.compile threw an exception while attempting to compile a template: ' + e);
              }
              return false;
            }
          }
    
          // it's assumed that the argument is already a template string if we're not in node
          else if ((typeof template).toLowerCase() !== 'string') {
            if (teddy.params.verbosity > 1) {
              console.log('Warning: teddy.compile attempted to compile a template which is not a string.');
            }
            return false;
          }
          
          // remove {! comments !} and unnecessary whitespace
          teddy.compiledTemplates[name] = template.replace(/{!(.*?)!}/g, '').replace(/[\f\n\r\t\v]*/g, '').replace(/\s{2,}/g, ' ').replace(/> </g, '><');
          
          // write eval'able js ready to send over to the client
          teddy.packagedTemplates[name] = 'teddy.compiledTemplates[\''+name+'\']=\''+teddy.compiledTemplates[name].replace(/'/g, '\\\'')+'\';';
        },

        // parses a template
        render: function(template, model, callback) {

          // needed because sigh
          if (oldIE) {
            console.log('Fatal error: Teddy does not support client-side templating on IE9 or below.');
            return false;
          }

          // handle bad or unsupplied model
          if (!model || (typeof model).toLowerCase() !== 'object') {
            model = {};
          }

          // needed for express.js support
          if (model.settings) {
            if (model.settings.views) {
              teddy.params.templateRoot = model.settings.views;
            }
          }

          // flatten model to produce case-insensitivity (needed because HTML is case-insensitive)
          model = teddy.flattenModel(model);

          // remove templateRoot from template name if necessary
          template = template.replace(teddy.params.templateRoot, '');

          // compile template if necessary
          if (!teddy.compiledTemplates[template]) {
            teddy.compile(template);
          }

          // declare vars
          var compiledTemplate = teddy.compiledTemplates[template], errors, renderedTemplate;

          // create dom object out of template string
          if (compiledTemplate) {
            renderedTemplate = parser.parseFromString(compiledTemplate, 'text/html');
          }
          else {
            if (teddy.params.verbosity) {
              console.log('Warning: teddy.render attempted to render a template which doesn\'t exist: ' + template);
            }
            return false;
          }

          // this hack is necessary for IE and Opera compatibility
          renderedTemplate = teddy.runUnknownElementParentSiblingHack(renderedTemplate);

          // since includes can introduce new conditionals, we loop until they're all dealt with
          while (teddy.findNonLoopedConditionals(renderedTemplate)[0] || teddy.findNonLoopedInclude(renderedTemplate)[0]) {

            // parse non-looped conditionals
            renderedTemplate = teddy.parseConditionals(renderedTemplate, model);

            // parse non-looped includes
            renderedTemplate = teddy.parseIncludes(renderedTemplate, model);
          }

          // parse loops and any conditionals or includes within
          renderedTemplate = teddy.parseLoops(renderedTemplate, model);

          // cleans up any remaining unnecessary <elseif>, <elseunless>, or <else> tags
          renderedTemplate = teddy.removeDanglingConditionals(renderedTemplate);
          
          // processes all remaining {vars}
          renderedTemplate = teddy.parseVars(renderedTemplate, model); // last one converts it to a string

          // execute callback if present, otherwise simply return the rendered template string
          if ((typeof callback).toLowerCase() === 'function') {
            if (!errors) {
              callback(null, renderedTemplate);
            }
            else {
              callback(errors, renderedTemplate);
            }
          }
          else {
            return renderedTemplate;
          }
        },


        /**
         * Teddy group parsing methods
         */

        // finds all <include> tags and renders them
        parseIncludes: function(doc, model) {
          var el,
              notDone = true,
              result;

          while (notDone) {
            el = teddy.findNonLoopedInclude(doc)[0];
            if (el) {
              notDone = true;
              result = teddy.renderInclude(el);
              if (result.newDoc) {
                doc = result;
              }
              else {
                teddy.replaceProcessedElement(el, result);
              }
            }
            else {
              notDone = false;
            }
          }
      
          return doc;
        },
        
        // finds all <if> and <unless> tags and renders them along with any related <elseif>, <elseunless>, and <else> tags
        parseConditionals: function(doc, model) {
          var el,
              result,
              conditionals = teddy.findNonLoopedConditionals(doc), // skips conditionals within <foreach> tags
              length,
              i;
          
          // process whitelisted conditionals
          length = conditionals.length;
          for (i = 0; i < length; i++) {
            el = conditionals[i];
            result = teddy.renderConditional(el, model);
            teddy.replaceProcessedElement(el, result);
          }
      
          return doc;
        },
        
        // finds all <foreach> tags and renders them
        parseLoops: function(doc, model) {
          var el,
              notDone = true,
              result;
          
          while (notDone) {
            el = doc.getElementsByTagName('foreach')[0];
            if (el) {
              notDone = true;
              result = teddy.renderForeach(el, model);
              teddy.replaceProcessedElement(el, result);
            }
            else {
              notDone = false;
            }
          }
      
          return doc;
        },

        // removes dangling <elseif>, <elseunless>, and <else> tags as they are no longer needed
        removeDanglingConditionals: function(doc) {
          var notDone = true, el;
      
          while (notDone) {
            el = doc.getElementsByTagName('elseif')[0] || doc.getElementsByTagName('elseunless')[0] || doc.getElementsByTagName('else')[0];
        
            if (el) {
              notDone = true;
              el.parentNode.removeChild(el);
            }
            else {
              notDone = false;
            }
          }
          
          return doc;
        },

        // finds alls {vars} in a given document and replaces them with values from the model
        parseVars: function(doc, model) {
          var docstring = (typeof doc).toLowerCase() === 'string' ? doc : serializer.serializeToString(doc), // not using serializer.serializeToString because this method can be called on a fully formed document and we don't want to exclude the root elements
              curls = docstring ? docstring.split('{') : false,
              numCurls = curls.length,
              curl,
              varname,
              i;

          if (curls) {
            for (i = 0; i < numCurls; i++) {
              curl = curls[(i + 1)];
              if (curl) {
                varname = curl.split('}')[0].toLowerCase();
                if (varname) {
                  try {
                    eval('docstring = teddy.renderVar(docstring, varname, model.'+varname.replace(/"/g, '\\"')+');');
                  }
                  catch (e) {
                    if (teddy.params.verbosity > 1) {
                      console.log('Warning: a {variable} was found with an invalid syntax: {' + varname + '}');
                      if (teddy.params.verbosity > 2) {
                        console.log('JS error thrown: ' + e);
                      }
                    }
                  }
                }
              }
            }
            return docstring;
          }
          else {
            if (teddy.params.verbosity > 1 && (typeof doc).toLowerCase() !== 'object') {
              console.log('Warning: teddy.parseVars called with invalid doc specified. Ignoring call.');
              return false;
            }
            else {
              return docstring;
            }
          }
        },


        /**
         * Teddy render methods
         */

        // parses a single <include> tag
        renderInclude: function(el) {
          var src, incdoc, args, argl, arg, argname, argval, i, newDoc;
        
          if (el) {
            src = el.getAttribute('src');
        
            if (!src) {
              if (teddy.params.verbosity) {
                console.log('Warning: <include> element found with no src attribute. Ignoring elment.');
              }
              return false;
            }
            else {

              // compile included template if necessary
              if (!teddy.compiledTemplates[src]) {
                teddy.compile(src);
              }
              
              // get the template as a string
              incdoc = teddy.compiledTemplates[src];
              
              // determine if it's a new document
              newDoc = (incdoc.toLowerCase().indexOf('<!doctype') > -1) ? true : false;

              if (!incdoc) {
                if (teddy.params.verbosity) {
                  console.log('Warning: <include> element found which references a nonexistent template ("' + src + '"). Ignoring elment.');
                }
                return false;
              }
      
              // process arguments
              args = el.childNodes;
              argl = args.length;
              for (i = 0; i < argl; i++) {
                arg = args[i];
                if (arg.nodeName.toLowerCase() !== 'arg' && !arg.getAttribute('data-unknownelementhack')) {
                  if (teddy.params.verbosity) {
                    console.log('Warning: child element found within a <include src="'+src+'"> that wasn\'t an <arg> element.');
                  }
                }
                else {
                  argname = arg.attributes[0];
                  argval = '';
          
                  if (argname) {
                    argname = argname.nodeName.toLowerCase(); // forces case insensitivity
                  }
                  else {
                    if (teddy.params.verbosity) {
                      console.log('Warning: <arg> element found with no attribute. Ignoring parent <include> element. (<include src="'+src+'">)');
                    }
                    return false;
                  }
          
                  // convert arg's children into a string
                  argval = teddy.stringifyElementChildren(arg);

                  // replace template string argument {var} with argument value
                  incdoc = teddy.renderVar(incdoc, argname, argval);
                }
              }

              // create a dom object out of parsed template string
              incdoc = parser.parseFromString(incdoc, 'text/html');

              // marks whether or not the included document is a new document or a partial
              incdoc.newDoc = newDoc;
              
              return incdoc;
            }
          }
          else {
            if (teddy.params.verbosity > 1) {
              console.log('Warning: teddy.renderInclude() called for an <include> element that does not exist.');
            }
            return false;
          }
        },
        
        // parses a single <foreach> tag
        renderForeach: function(el, model) {
          if (el) {
            var key = el.getAttribute('key'),
                val = el.getAttribute('val'),
                collection = el.getAttribute('in'),
                i,
                loopContent = '',
                parsedLoop = '',
                item;    
        
            if (!val) {
              if (teddy.params.verbosity) {
                console.log('Warning: <foreach> element found with no "val" attribute. Ignoring elment.');
              }
              return false;
            }
            else if (!collection) {
              if (teddy.params.verbosity) {
                console.log('Warning: <foreach> element found with no "in" attribute. Ignoring elment.');
              }
              return false;
            }
            else {
              collection = model[collection];
              if (!collection) {
                if (teddy.params.verbosity) {
                  console.log('Warning: <foreach> element found with undefined value specified for "in" attribute. Ignoring elment.');
                }
                return false;
              }
              else {

                // tells parseConditionals that this foreach is safe to process conditionals in
                el.setAttribute('looped', 'true');
              
                loopContent = teddy.stringifyElementChildren(el);

                // process loop
                for (i in collection) {
                  item = collection[i];

                  // define local model for the iteration
                  // if model[val] or model[key] preexist, they will be overwritten by the locally supplied variables
                  model[val] = item;
                  if (key) {
                    model[key] = i;
                  }

                  parsedLoop += teddy.parseVars(loopContent, model);

                  // create a dom object out of parsed template string
                  el = parser.parseFromString(parsedLoop, 'text/html');

                  // since includes can introduce new conditionals, we loop until they're all dealt with
                  while (teddy.findNonLoopedConditionals(el)[0] || teddy.findNonLoopedInclude(el)[0]) {
        
                    // find conditionals within the loop and process them
                    el = teddy.parseConditionals(el, model);
  
                    // find includes within the loop and process them
                    el = teddy.parseIncludes(el, model);
                  }

                  // okay, we're done with this iteration. we need to convert it back to a string for the next iteration
                  parsedLoop = teddy.stringifyElement(el);
                }

                return el;
              }
            }
          }
          else {
            if (teddy.params.verbosity > 1) {
              console.log('Warning: teddy.renderForeach() called for a <foreach> element that does not exist.');
            }
            return false;
          }
        },
        
        // parses a single <if> or <unless> tag and any related <elseif>, <elseunless>, and <else> tags
        renderConditional: function(el, model) {
          if (el) {
            var satisfiedCondition = false,
                nextSibling = el,
                nextSiblingName = nextSibling.nodeName.toLowerCase(),
                conditionContent;

            while (!satisfiedCondition) {

              // satisfied condition
              if (teddy.evalCondition(el, model)) {
                satisfiedCondition = true;
      
                // get condition's children and stringify them
                conditionContent = teddy.stringifyElementChildren(el);

                // create a dom object out of that string
                el = parser.parseFromString(conditionContent, 'text/html');

                return el;
              }
              
              // failed condition, try the next one
              else if (nextSibling) {

                // get next elseif, elseunless, or else statement and evaluate it
                nextSiblingName = nextSibling;
                nextSibling = nextSibling.nextSibling;
                nextSiblingName = nextSibling ? nextSibling.nodeName.toLowerCase() : false;
                while (nextSibling) {
                  if (nextSiblingName == 'if' || nextSiblingName == 'unless') {
                    satisfiedCondition = true; // none of the conditions were true
                    break;
                  }
                  else if (nextSiblingName == 'elseif' || nextSiblingName == 'elseunless' || nextSiblingName == 'else') {
                    el = nextSibling; // advance parent loop
                    break;
                  }
                  else {
                    nextSibling = nextSibling.nextSibling;
                  }
                }
              }
              
              // no further siblings; no further conditions to test
              else {
                return false;
              }
            }
          }
          else {
            if (teddy.params.verbosity > 1) {
              console.log('Warning: teddy.renderConditional() called for a <if> or <unless> element with no condition supplied.');
            }
            return false;
          }
        },
      
        // determines if a condition is true for <if>, <unless>, <elseif>, and <elseunless>
        evalCondition: function(el, model) {
        
          // some browsers annoyingly add an xmlns attribtue to pretty much everything when parsing HTML through DOMParser's parseFromString method. since xmlns attributes mess up the syntax for Teddy conditionals, we have to remove any xmlns attributes present before evaluating the condtional 
          el.removeAttribute('xmlns');
        
          var conditionType = el.nodeName.toLowerCase(),
              conditionAttr = el.attributes[0],
              condition,
              conditionVal,
              modelVal;

          if (conditionType == 'else') {
            return true;
          }
          else {
            condition = conditionAttr.nodeName.toLowerCase();
            conditionVal = conditionAttr.value;
            try {
              eval('modelVal = model.'+condition+';'); // necessary because condition could be multilayered, e.g. "model.foo.bar.blah"
            }
            catch (e) {
              if (teddy.params.verbosity) {
                console.log('Warning: teddy.evalCondition() supplied a nonexistent model var: model.'+condition);
                if (teddy.params.verbosity > 1) {
                  console.log(e);
                }
              }
              return false;
            }
          }

          if (conditionType == 'if' || conditionType == 'elseif') {
            if (condition == conditionVal.toLowerCase() || conditionVal === '') {
              return modelVal ? true : false;
            }
            else if (modelVal == conditionVal) {
              return true;
            }
            else {
              return false;
            }
          }
          else {
            if (condition == conditionVal.toLowerCase() || conditionVal === '') {
              return modelVal ? false : true;
            }
            else if (modelVal != conditionVal) {
              return true;
            }
            else {
              return false;
            }
          }
        },
        
        // replaces a single {var} with its value from a given model
        renderVar: function(str, varname, varval) {
          if (str) {
          
            // hack to typecast to string
            varname = '' + varname;
            varval = '' + varval;

            try {
              eval('str = str.replace(/{'+varname.replace(/"/g, '\\"')+'}/gi, "'+varval.replace(/"/g, '\\"')+'");');
            }
            catch (e) {
              if (teddy.params.verbosity > 1) {
                console.log('Warning: a {variable} was found with an invalid syntax: {' + varname + '}');
                if (teddy.params.verbosity > 2) {
                  console.log('JS error thrown: ' + e);
                }
              }
            }
            return str;
          }
          else {
            if (teddy.params.verbosity > 1) {
              console.log('Warning: an empty string was passed to teddy.renderVar.');
            }
          }
        },

        // finds an <include> tag that is not within any <foreach> tag
        findNonLoopedInclude: function(doc) {
          var el,
              parent,
              includes = [],
              tags = doc.getElementsByTagName('include'),
              length = tags.length,
              skip = false,
              i;

          for (i = 0; i < length; i ++) {
            el = tags[i];
            parent = el ? el.parentNode : false;
            while (parent && !skip) {
              if (parent.nodeName) {
                if (parent.nodeName.toLowerCase() == 'foreach') {
                  if (!parent.getAttribute('looped')) {
                    skip = true;
                  }
                }
              }
              parent = parent.parentNode;
            }
            if (el && !skip) {
              includes.push(el);
              return includes;
            }
            else {
              skip = false;
            }
          }

          return includes;
        },

        // finds all <if> and <unless> tags that are not within any <foreach> tags
        findNonLoopedConditionals: function(doc) {
          var el,
              parent,
              notDone = true,
              conditionals = [],
              ifs = doc.getElementsByTagName('if'),
              length = ifs.length,
              unlesses = false,
              skip = false,
              i;

          while (notDone) {
            for (i = 0; i < length; i ++) {
              el = ifs[i];
              parent = el ? el.parentNode : false;
              while (parent && !skip) {
                if (parent.nodeName) {
                  if (parent.nodeName.toLowerCase() == 'foreach') {
                    if (!parent.getAttribute('looped')) { // exemption check
                      skip = true;
                    }
                  }
                }
                parent = parent.parentNode;
              }
              if (el && !skip) {
                conditionals.push(el);
              }
              else {
                skip = false;
              }
            }
            
            // we're done with <if>s, so do <unless>es if necessary
            if (!unlesses) {
              // set it to unlesses for one more pass
              ifs = doc.getElementsByTagName('unless');
              length = ifs.length;
              unlesses = true;
            }
            else {
              notDone = false; // we're done, break loop
            }
          }

          return conditionals;
        },


        /**
         * Utility methods
         */
  
        // normalizes XMLSerializer's serializeToString method (fixes some browser compatibility issues)
        stringifyElement: function(el) {
          var innerHTML = false, body = el.body;
  
          // try innerHTML
          if (body) {
            innerHTML = body.innerHTML;
            if (innerHTML) {
              return innerHTML;
            }
          }
          
          // innerHTML failed, so just return the standard serializer
          return serializer.serializeToString(el);
        },
        
        // converts all of a DOM node's children into a single string
        stringifyElementChildren: function(el) {
          if (el) {
            var childNodes = el.childNodes, i, child, childString = '';
        
            for (i in childNodes) {
              child = childNodes[i];
              if ((typeof child).toLowerCase() === 'object') {
                childString += teddy.stringifyElement(child);
              }
            }
            
            return childString;
          }
          else {
            if (teddy.params.verbosity > 1) {
              console.log('Warning: teddy.stringifyElementChildren called on a non-DOM object');
            }
            return false;
          }
        },
        
        // makes a JSON structure's keys all lower case (all variables in Teddy templates are case-insensitive because HTML is case-insensitive)
        flattenModel: function(model) {
          var newModel = {}, i, item;
          for (i in model) {
            item = model[i];
            if ((typeof item).toLowerCase() === 'object') {
              item = teddy.flattenModel(item);
            }
            newModel[i.toLowerCase()] = item;
          }
          return newModel;
        },
  
        // replaces 'el' with 'result'
        replaceProcessedElement: function(el, result) {
          if (!el) {
            if (teddy.params.verbosity > 1) {
              console.log('Warning: teddy.replaceProcessedElement called without being supplied a valid element to replace');
            }
            return false;
          }
  
          var parent = el.parentNode, sibling = el.nextSibling, i, children, length, child, clone;
  
          if (parent) {
            parent.removeChild(el);
          }
          else {
            if (teddy.params.verbosity > 1) {
              console.log('Warning: teddy.replaceProcessedElement called on an object without a parentNode');
            }
            return false;
          }
  
          if (result) {
            if (isNode) {
              if (sibling) {
                parent.insertBefore(result, sibling);
              }
              else {
                parent.appendChild(result);
              }
            }
            else {
              result = result.body;
              children = result.childNodes;
              length = children.length;
              for (i = 0; i < length; i++) {
                child = children[i];
                if ((typeof child).toLowerCase() === 'object') {
                  clone = child.cloneNode(true);
                  if (sibling) {
                    parent.insertBefore(clone, sibling);
                  }
                  else {
                    parent.appendChild(clone);
                  }
                }
              }
            }
          }
          else {
            if (teddy.params.verbosity > 1) {
              console.log('Warning: teddy.replaceProcessedElement called without being supplied a result');
            }
            return false;
          }
        },
  
        // hack to work around Opera and MSIE bug in which DOMParser's parseFromString method incorrectly parses empty UnknownElements. Since <include> tags can sometimes not have children, this hack is necessary for Opera and IE compatibility. This bug was reported to Opera as bug DSK-381933. Attempted to report the bug to Microsoft too, but they don't appear to have a way of doing that.
        runUnknownElementParentSiblingHack: function(doc) {
          if (!isNode) {
            var includes, inlength, i, el, hack, hasBug = parser.parseFromString(serializer.serializeToString(parser.parseFromString('<z></z><p></p>', 'text/html')), 'text/html').getElementsByTagName('z')[0].firstChild;
  
            if (hasBug) {
              includes = doc.body.getElementsByTagName('include');
              inlength = includes.length;
              for (i = 0; i < inlength; i++) {
                el = includes[i];
                if (!el.firstChild) {
                  hack = document.createElement('p');
                  hack.setAttribute('data-unknownelementhack', 'true');
                  hack.setAttribute('hidden', 'hidden');
                  hack.setAttribute('style', 'display:none');
                  hack.innerHTML = 'h';
                  el.appendChild(hack);
                }
              }
            }
          }
          return doc;
        },
        
        
        /**
         * Error handler methods
         */
  
        // suppresses xml warnings (because Teddy is a made-up HTML syntax)
        DOMParserWarningHandler: function(e) {
          if (teddy.params.verbosity > 2) {
            console.log('DEBUG Warning: DOMParser issued the following warning: ' + e);
          }
        },
        
        // logs xml errors
        DOMParserErrorHandler: function(e) {
          if (teddy.params.verbosity) {
            console.log(e);
          }
        },
      
        // logs file I/O errors in node.js
        readFileError: function(e) {
          if (teddy.params.verbosity) {
            console.log('Warning: teddy.compile attempting to compile a template which doesn\'t exist: ' + e);
          }
        },


        /**
         * Teddy object public member vars
         */

        // compiled templates are stored as object collections, e.g. { "myTemplate.html": "<p>some markup</p>"}
        compiledTemplates: {},

        // packaged templates are stored as raw JS statements that can be sent to the client and eval'd, e.g. "teddy.compiledTemplates['myTemplate.html']='<p>some markup</p>';"
        packagedTemplates: {},

        // default values for parameters sent to teddy
        params: {
          verbosity: 1,
          templateRoot: './'
        },
        
        
        /**
         * Mutator methods for Teddy object public member vars
         */

        // mutator method to set verbosity param. takes human-readable string argument and converts it to an integer for more efficient checks against the setting
        setVerbosity: function(v) {
          switch (v) {
            case 'none':
              v = 0;
              break;
            case 'verbose':
              v = 2;
              break;
            case 'DEBUG':
              v = 3;
              break;
            default: // case 'concise':
              v = 1;
          }
          teddy.params.verbosity = v;
        },
        
        // mutator method to set template root param; must be a string
        setTemplateRoot: function(v) {
          teddy.params.templateRoot = String(v);
        }
      },

      // private utility vars
      isNode = ((typeof module).toLowerCase() !== 'undefined' && module.exports) ? true : false,
      fs,
      xmldom,
      parser,
      serializer,
      oldIE;

  // set env specific vars for node.js
  if (isNode) {
    module.exports = teddy; // makes teddy requirable in node.js
    module.exports.__express = teddy.render; // express.js support

    // node module dependencies
    fs = require('fs');
    xmldom = require('./xmldom-teddyfork'); // TODO: get author of xmldom master branch to accept this pull request https://github.com/kethinov/xmldom/commit/afea22460fa7d846564285435e8f22d9181af97f so we don't need to bundle a forked xmldom anymore

    // define parser and serializer from xmldom
    parser = new xmldom.DOMParser({
      errorHandler: {
        warning: teddy.DOMParserWarningHandler,
        error: teddy.DOMParserErrorHandler,
        fatalError: teddy.DOMParserErrorHandler
      }
    }),
    serializer = new xmldom.XMLSerializer();

  }
  
  // set env specific vars for client-side
  else {
    this.teddy = teddy;

    // test for old IE
    oldIE = document.createElement('p');
    oldIE.innerHTML = '<!--[if lte IE 9]><i></i><![endif]-->';
    oldIE = oldIE.getElementsByTagName('i').length === 1 ? true : false;

    if (!oldIE) {
      parser = new DOMParser();
      serializer = new XMLSerializer();

      /*
       * DOMParser HTML extension
       * 2012-09-04
       *
       * By Eli Grey, http://eligrey.com
       * Modified for use in Teddy by Eric Newport (kethinov)
       * Public domain.
       * NO WARRANTY EXPRESSED OR IMPLIED. USE AT YOUR OWN RISK.
       */
      
      /*! @source https://gist.github.com/kethinov/4760460 */
      /*global document, DOMParser*/
      
      (function(DOMParser) {
        "use strict";
        
        var DOMParserProto = DOMParser.prototype,
            realParseFromString = DOMParserProto.parseFromString;
        
        // Firefox/Opera/IE throw errors on unsupported types
        try {
          // WebKit returns null on unsupported types
          if ((new DOMParser()).parseFromString("", "text/html")) {
            // text/html parsing is natively supported
            return;
          }
        }
        catch (ex) {}
        
        DOMParserProto.parseFromString = function(markup, type) {
          if (/^\s*text\/html\s*(?:;|$)/i.test(type)) {
            var doc = document.implementation.createHTMLDocument('');
            if (markup.toLowerCase().indexOf('<!doctype') > -1) {
              doc.documentElement.innerHTML = markup;
            }
            else {
              doc.body.innerHTML = markup;
            }
            return doc;
          }
          else {
            return realParseFromString.apply(this, arguments);
          }
        };
      }(DOMParser));
    }
  }
})();