import { RenderBatch, ArrayBuilderSegment, RenderTreeEdit, RenderTreeFrame, EditType, FrameType, ArrayValues } from './RenderBatch/RenderBatch';
import { EventDelegator } from './Events/EventDelegator';
import { LogicalElement, PermutationListEntry, toLogicalElement, insertLogicalChild, removeLogicalChild, getLogicalParent, getLogicalChild, createAndInsertLogicalContainer, isSvgElement, getLogicalChildrenArray, getLogicalSiblingEnd, permuteLogicalChildren, getClosestDomElement, emptyLogicalElement } from './LogicalElements';
import { applyCaptureIdToElement } from './ElementReferenceCapture';
import { attachToEventDelegator as attachNavigationManagerToEventDelegator } from '../Services/NavigationManager';
const deferredValuePropname = '_blazorDeferredValue';
const sharedTemplateElemForParsing = document.createElement('template');
const sharedSvgElemForParsing = document.createElementNS('http://www.w3.org/2000/svg', 'g');
const elementsToClearOnRootComponentRender: { [componentId: number]: LogicalElement } = {};
const internalAttributeNamePrefix = '__internal_';
const eventPreventDefaultAttributeNamePrefix = 'preventDefault_';
const eventStopPropagationAttributeNamePrefix = 'stopPropagation_';

export class BrowserRenderer {
  public eventDelegator: EventDelegator;

  private rootComponentIds = new Set<number>();
  private childComponentLocations: { [componentId: number]: LogicalElement } = {};

  public constructor(browserRendererId: number) {
    this.eventDelegator = new EventDelegator(browserRendererId);

    // We don't yet know whether or not navigation interception will be enabled, but in case it will be,
    // we wire up the navigation manager to the event delegator so it has the option to participate
    // in the synthetic event bubbling process later
    attachNavigationManagerToEventDelegator(this.eventDelegator);
  }

  public attachRootComponentToLogicalElement(componentId: number, element: LogicalElement, appendContent: boolean): void {
    this.attachComponentToElement(componentId, element);
    this.rootComponentIds.add(componentId);

    // If we want to preserve existing HTML content of the root element, we don't apply the mechanism for
    // clearing existing children. Rendered content will then append rather than replace the existing HTML content.
    if (!appendContent) {
      elementsToClearOnRootComponentRender[componentId] = element;
    }
  }

  public updateComponent(batch: RenderBatch, componentId: number, edits: ArrayBuilderSegment<RenderTreeEdit>, referenceFrames: ArrayValues<RenderTreeFrame>): void {
    const element = this.childComponentLocations[componentId];
    if (!element) {
      throw new Error(`No element is currently associated with component ${componentId}`);
    }

    // On the first render for each root component, clear any existing content (e.g., prerendered)
    const rootElementToClear = elementsToClearOnRootComponentRender[componentId];
    if (rootElementToClear) {
      const rootElementToClearEnd = getLogicalSiblingEnd(rootElementToClear);
      delete elementsToClearOnRootComponentRender[componentId];

      if (!rootElementToClearEnd) {
        clearElement(rootElementToClear as unknown as Element);
      } else {
        clearBetween(rootElementToClear as unknown as Node, rootElementToClearEnd as unknown as Comment);
      }
    }

    const ownerDocument = getClosestDomElement(element)?.getRootNode() as Document;
    const activeElementBefore = ownerDocument && ownerDocument.activeElement;

    this.applyEdits(batch, componentId, element, 0, edits, referenceFrames);

    // Try to restore focus in case it was lost due to an element move
    if ((activeElementBefore instanceof HTMLElement) && ownerDocument && ownerDocument.activeElement !== activeElementBefore) {
      activeElementBefore.focus();
    }
  }

  public disposeComponent(componentId: number) {
    if (this.rootComponentIds.delete(componentId)) {
      // When disposing a root component, the container element won't be removed from the DOM (because there's
      // no parent to remove that child), so we empty it to restore it to the state it was in before the root
      // component was added.
      emptyLogicalElement(this.childComponentLocations[componentId]);
    }

    delete this.childComponentLocations[componentId];
  }

  public disposeEventHandler(eventHandlerId: number) {
    this.eventDelegator.removeListener(eventHandlerId);
  }

  private attachComponentToElement(componentId: number, element: LogicalElement) {
    this.childComponentLocations[componentId] = element;
  }

  private applyEdits(batch: RenderBatch, componentId: number, parent: LogicalElement, childIndex: number, edits: ArrayBuilderSegment<RenderTreeEdit>, referenceFrames: ArrayValues<RenderTreeFrame>) {
    let currentDepth = 0;
    let childIndexAtCurrentDepth = childIndex;
    let permutationList: PermutationListEntry[] | undefined;

    const arrayBuilderSegmentReader = batch.arrayBuilderSegmentReader;
    const editReader = batch.editReader;
    const frameReader = batch.frameReader;
    const editsValues = arrayBuilderSegmentReader.values(edits);
    const editsOffset = arrayBuilderSegmentReader.offset(edits);
    const editsLength = arrayBuilderSegmentReader.count(edits);
    const maxEditIndexExcl = editsOffset + editsLength;

    for (let editIndex = editsOffset; editIndex < maxEditIndexExcl; editIndex++) {
      const edit = batch.diffReader.editsEntry(editsValues, editIndex);
      const editType = editReader.editType(edit);
      switch (editType) {
        case EditType.prependFrame: {
          const frameIndex = editReader.newTreeIndex(edit);
          const frame = batch.referenceFramesEntry(referenceFrames, frameIndex);
          const siblingIndex = editReader.siblingIndex(edit);
          this.insertFrame(batch, componentId, parent, childIndexAtCurrentDepth + siblingIndex, referenceFrames, frame, frameIndex);
          break;
        }
        case EditType.removeFrame: {
          const siblingIndex = editReader.siblingIndex(edit);
          removeLogicalChild(parent, childIndexAtCurrentDepth + siblingIndex);
          break;
        }
        case EditType.setAttribute: {
          const frameIndex = editReader.newTreeIndex(edit);
          const frame = batch.referenceFramesEntry(referenceFrames, frameIndex);
          const siblingIndex = editReader.siblingIndex(edit);
          const element = getLogicalChild(parent, childIndexAtCurrentDepth + siblingIndex);
          if (element instanceof Element) {
            this.applyAttribute(batch, componentId, element, frame);
          } else {
            throw new Error('Cannot set attribute on non-element child');
          }
          break;
        }
        case EditType.removeAttribute: {
          // Note that we don't have to dispose the info we track about event handlers here, because the
          // disposed event handler IDs are delivered separately (in the 'disposedEventHandlerIds' array)
          const siblingIndex = editReader.siblingIndex(edit);
          const element = getLogicalChild(parent, childIndexAtCurrentDepth + siblingIndex);
          if (element instanceof HTMLElement) {
            const attributeName = editReader.removedAttributeName(edit)!;
            // First try to remove any special property we use for this attribute
            if (!this.tryApplySpecialProperty(batch, element, attributeName, null)) {
              // If that's not applicable, it's a regular DOM attribute so remove that
              element.removeAttribute(attributeName);
            }
          } else {
            throw new Error('Cannot remove attribute from non-element child');
          }
          break;
        }
        case EditType.updateText: {
          const frameIndex = editReader.newTreeIndex(edit);
          const frame = batch.referenceFramesEntry(referenceFrames, frameIndex);
          const siblingIndex = editReader.siblingIndex(edit);
          const textNode = getLogicalChild(parent, childIndexAtCurrentDepth + siblingIndex);
          if (textNode instanceof Text) {
            textNode.textContent = frameReader.textContent(frame);
          } else {
            throw new Error('Cannot set text content on non-text child');
          }
          break;
        }
        case EditType.updateMarkup: {
          const frameIndex = editReader.newTreeIndex(edit);
          const frame = batch.referenceFramesEntry(referenceFrames, frameIndex);
          const siblingIndex = editReader.siblingIndex(edit);
          removeLogicalChild(parent, childIndexAtCurrentDepth + siblingIndex);
          this.insertMarkup(batch, parent, childIndexAtCurrentDepth + siblingIndex, frame);
          break;
        }
        case EditType.stepIn: {
          const siblingIndex = editReader.siblingIndex(edit);
          parent = getLogicalChild(parent, childIndexAtCurrentDepth + siblingIndex);
          currentDepth++;
          childIndexAtCurrentDepth = 0;
          break;
        }
        case EditType.stepOut: {
          parent = getLogicalParent(parent)!;
          currentDepth--;
          childIndexAtCurrentDepth = currentDepth === 0 ? childIndex : 0; // The childIndex is only ever nonzero at zero depth
          break;
        }
        case EditType.permutationListEntry: {
          permutationList = permutationList || [];
          permutationList.push({
            fromSiblingIndex: childIndexAtCurrentDepth + editReader.siblingIndex(edit),
            toSiblingIndex: childIndexAtCurrentDepth + editReader.moveToSiblingIndex(edit),
          });
          break;
        }
        case EditType.permutationListEnd: {
          permuteLogicalChildren(parent, permutationList!);
          permutationList = undefined;
          break;
        }
        default: {
          const unknownType: never = editType; // Compile-time verification that the switch was exhaustive
          throw new Error(`Unknown edit type: ${unknownType}`);
        }
      }
    }
  }

  private insertFrame(batch: RenderBatch, componentId: number, parent: LogicalElement, childIndex: number, frames: ArrayValues<RenderTreeFrame>, frame: RenderTreeFrame, frameIndex: number): number {
    const frameReader = batch.frameReader;
    const frameType = frameReader.frameType(frame);
    switch (frameType) {
      case FrameType.element:
        this.insertElement(batch, componentId, parent, childIndex, frames, frame, frameIndex);
        return 1;
      case FrameType.text:
        this.insertText(batch, parent, childIndex, frame);
        return 1;
      case FrameType.attribute:
        throw new Error('Attribute frames should only be present as leading children of element frames.');
      case FrameType.component:
        this.insertComponent(batch, parent, childIndex, frame);
        return 1;
      case FrameType.region:
        return this.insertFrameRange(batch, componentId, parent, childIndex, frames, frameIndex + 1, frameIndex + frameReader.subtreeLength(frame));
      case FrameType.elementReferenceCapture:
        if (parent instanceof Element) {
          applyCaptureIdToElement(parent, frameReader.elementReferenceCaptureId(frame)!);
          return 0; // A "capture" is a child in the diff, but has no node in the DOM
        } else {
          throw new Error('Reference capture frames can only be children of element frames.');
        }
      case FrameType.markup:
        this.insertMarkup(batch, parent, childIndex, frame);
        return 1;
      default:
        const unknownType: never = frameType; // Compile-time verification that the switch was exhaustive
        throw new Error(`Unknown frame type: ${unknownType}`);
    }
  }

  private insertElement(batch: RenderBatch, componentId: number, parent: LogicalElement, childIndex: number, frames: ArrayValues<RenderTreeFrame>, frame: RenderTreeFrame, frameIndex: number) {
    const frameReader = batch.frameReader;
    const tagName = frameReader.elementName(frame)!;

    const newDomElementRaw = (tagName === 'svg' || isSvgElement(parent)) ?
      document.createElementNS('http://www.w3.org/2000/svg', tagName) :
      document.createElement(tagName);
    const newElement = toLogicalElement(newDomElementRaw);

    let inserted = false;

    // Apply attributes
    const descendantsEndIndexExcl = frameIndex + frameReader.subtreeLength(frame);
    for (let descendantIndex = frameIndex + 1; descendantIndex < descendantsEndIndexExcl; descendantIndex++) {
      const descendantFrame = batch.referenceFramesEntry(frames, descendantIndex);
      if (frameReader.frameType(descendantFrame) === FrameType.attribute) {
        this.applyAttribute(batch, componentId, newDomElementRaw, descendantFrame);
      } else {
        insertLogicalChild(newDomElementRaw, parent, childIndex);
        inserted = true;
        // As soon as we see a non-attribute child, all the subsequent child frames are
        // not attributes, so bail out and insert the remnants recursively
        this.insertFrameRange(batch, componentId, newElement, 0, frames, descendantIndex, descendantsEndIndexExcl);
        break;
      }
    }

    // this element did not have any children, so it's not inserted yet.
    if (!inserted) {
      insertLogicalChild(newDomElementRaw, parent, childIndex);
    }

    // We handle setting 'value' on a <select> in three different ways:
    // [1] When inserting a corresponding <option>, in case you're dynamically adding options.
    //     This is the case below.
    // [2] After we finish inserting the <select>, in case the descendant options are being
    //     added as an opaque markup block rather than individually. This is the other case below.
    // [3] In case the the value of the select and the option value is changed in the same batch.
    //     We just receive an attribute frame and have to set the select value afterwards.

    // We also defer setting the 'value' property for <input> because certain types of inputs have
    // default attribute values that may incorrectly constain the specified 'value'.
    // For example, range inputs have default 'min' and 'max' attributes that may incorrectly
    // clamp the 'value' property if it is applied before custom 'min' and 'max' attributes.

    if (newDomElementRaw instanceof HTMLOptionElement) {
      // Situation 1
      this.trySetSelectValueFromOptionElement(newDomElementRaw);
    } else if (deferredValuePropname in newDomElementRaw) {
      // Situation 2
      setDeferredElementValue(newDomElementRaw, newDomElementRaw[deferredValuePropname]);
    }
  }

  private trySetSelectValueFromOptionElement(optionElement: HTMLOptionElement) {
    const selectElem = this.findClosestAncestorSelectElement(optionElement);

    if (!selectElem || !(deferredValuePropname in selectElem)) {
      return false;
    }

    if (isMultipleSelectElement(selectElem)) {
      optionElement.selected = selectElem[deferredValuePropname].indexOf(optionElement.value) !== -1;
    } else {
      if (selectElem[deferredValuePropname] !== optionElement.value) {
        return false;
      }

      setSingleSelectElementValue(selectElem, optionElement.value);
      delete selectElem[deferredValuePropname];
    }

    return true;
  }

  private insertComponent(batch: RenderBatch, parent: LogicalElement, childIndex: number, frame: RenderTreeFrame) {
    const containerElement = createAndInsertLogicalContainer(parent, childIndex);

    // All we have to do is associate the child component ID with its location. We don't actually
    // do any rendering here, because the diff for the child will appear later in the render batch.
    const childComponentId = batch.frameReader.componentId(frame);
    this.attachComponentToElement(childComponentId, containerElement);
  }

  private insertText(batch: RenderBatch, parent: LogicalElement, childIndex: number, textFrame: RenderTreeFrame) {
    const textContent = batch.frameReader.textContent(textFrame)!;
    const newTextNode = document.createTextNode(textContent);
    insertLogicalChild(newTextNode, parent, childIndex);
  }

  private insertMarkup(batch: RenderBatch, parent: LogicalElement, childIndex: number, markupFrame: RenderTreeFrame) {
    const markupContainer = createAndInsertLogicalContainer(parent, childIndex);

    const markupContent = batch.frameReader.markupContent(markupFrame);
    const parsedMarkup = parseMarkup(markupContent, isSvgElement(parent));
    let logicalSiblingIndex = 0;
    while (parsedMarkup.firstChild) {
      insertLogicalChild(parsedMarkup.firstChild, markupContainer, logicalSiblingIndex++);
    }
  }

  private applyAttribute(batch: RenderBatch, componentId: number, toDomElement: Element, attributeFrame: RenderTreeFrame) {
    const frameReader = batch.frameReader;
    const attributeName = frameReader.attributeName(attributeFrame)!;
    const eventHandlerId = frameReader.attributeEventHandlerId(attributeFrame);

    if (eventHandlerId) {
      const eventName = stripOnPrefix(attributeName);
      this.eventDelegator.setListener(toDomElement, eventName, eventHandlerId, componentId);
      return;
    }

    // First see if we have special handling for this attribute
    if (!this.tryApplySpecialProperty(batch, toDomElement, attributeName, attributeFrame)) {
      // If not, treat it as a regular string-valued attribute
      toDomElement.setAttribute(
        attributeName,
        frameReader.attributeValue(attributeFrame)!
      );
    }
  }

  private tryApplySpecialProperty(batch: RenderBatch, element: Element, attributeName: string, attributeFrame: RenderTreeFrame | null) {
    switch (attributeName) {
      case 'value':
        return this.tryApplyValueProperty(batch, element, attributeFrame);
      case 'checked':
        return this.tryApplyCheckedProperty(batch, element, attributeFrame);
      default: {
        if (attributeName.startsWith(internalAttributeNamePrefix)) {
          this.applyInternalAttribute(batch, element, attributeName.substring(internalAttributeNamePrefix.length), attributeFrame);
          return true;
        }
        return false;
      }
    }
  }

  private applyInternalAttribute(batch: RenderBatch, element: Element, internalAttributeName: string, attributeFrame: RenderTreeFrame | null) {
    const attributeValue = attributeFrame ? batch.frameReader.attributeValue(attributeFrame) : null;

    if (internalAttributeName.startsWith(eventStopPropagationAttributeNamePrefix)) {
      // Stop propagation
      const eventName = stripOnPrefix(internalAttributeName.substring(eventStopPropagationAttributeNamePrefix.length));
      this.eventDelegator.setStopPropagation(element, eventName, attributeValue !== null);
    } else if (internalAttributeName.startsWith(eventPreventDefaultAttributeNamePrefix)) {
      // Prevent default
      const eventName = stripOnPrefix(internalAttributeName.substring(eventPreventDefaultAttributeNamePrefix.length));
      this.eventDelegator.setPreventDefault(element, eventName, attributeValue !== null);
    } else {
      // The prefix makes this attribute name reserved, so any other usage is disallowed
      throw new Error(`Unsupported internal attribute '${internalAttributeName}'`);
    }
  }

  private tryApplyValueProperty(batch: RenderBatch, element: Element, attributeFrame: RenderTreeFrame | null): boolean {
    // Certain elements have built-in behaviour for their 'value' property
    const frameReader = batch.frameReader;

    let value = attributeFrame ? frameReader.attributeValue(attributeFrame) : null;

    if (value && element.tagName === 'INPUT') {
      value = normalizeInputValue(value, element.getAttribute('type'));
    }

    switch (element.tagName) {
      case 'INPUT':
      case 'SELECT':
      case 'TEXTAREA': {
        // <select> is special, in that anything we write to .value will be lost if there
        // isn't yet a matching <option>. To maintain the expected behavior no matter the
        // element insertion/update order, preserve the desired value separately so
        // we can recover it when inserting any matching <option> or after inserting an
        // entire markup block of descendants.

        // We also defer setting the 'value' property for <input> because certain types of inputs have
        // default attribute values that may incorrectly constain the specified 'value'.
        // For example, range inputs have default 'min' and 'max' attributes that may incorrectly
        // clamp the 'value' property if it is applied before custom 'min' and 'max' attributes.

        if (value && element instanceof HTMLSelectElement && isMultipleSelectElement(element)) {
          value = JSON.parse(value);
        }

        setDeferredElementValue(element, value);
        element[deferredValuePropname] = value;

        return true;
      }
      case 'OPTION': {
        if (value || value === '') {
          element.setAttribute('value', value);
        } else {
          element.removeAttribute('value');
        }

        // See above for why we have this special handling for <select>/<option>
        // Situation 3
        this.trySetSelectValueFromOptionElement(<HTMLOptionElement>element);
        return true;
      }
      default:
        return false;
    }
  }

  private tryApplyCheckedProperty(batch: RenderBatch, element: Element, attributeFrame: RenderTreeFrame | null) {
    // Certain elements have built-in behaviour for their 'checked' property
    if (element.tagName === 'INPUT') {
      const value = attributeFrame ? batch.frameReader.attributeValue(attributeFrame) : null;
      (element as any).checked = value !== null;
      return true;
    } else {
      return false;
    }
  }

  private findClosestAncestorSelectElement(element: Element | null) {
    while (element) {
      if (element instanceof HTMLSelectElement) {
        return element;
      } else {
        element = element.parentElement;
      }
    }

    return null;
  }

  private insertFrameRange(batch: RenderBatch, componentId: number, parent: LogicalElement, childIndex: number, frames: ArrayValues<RenderTreeFrame>, startIndex: number, endIndexExcl: number): number {
    const origChildIndex = childIndex;
    for (let index = startIndex; index < endIndexExcl; index++) {
      const frame = batch.referenceFramesEntry(frames, index);
      const numChildrenInserted = this.insertFrame(batch, componentId, parent, childIndex, frames, frame, index);
      childIndex += numChildrenInserted;

      // Skip over any descendants, since they are already dealt with recursively
      index += countDescendantFrames(batch, frame);
    }

    return (childIndex - origChildIndex); // Total number of children inserted
  }
}

export interface ComponentDescriptor {
  start: Node;
  end: Node;
}

function parseMarkup(markup: string, isSvg: boolean) {
  if (isSvg) {
    sharedSvgElemForParsing.innerHTML = markup || ' ';
    return sharedSvgElemForParsing;
  } else {
    sharedTemplateElemForParsing.innerHTML = markup || ' ';
    return sharedTemplateElemForParsing.content;
  }
}

function normalizeInputValue(value: string, type: string | null): string {
  // Time inputs (e.g. 'time' and 'datetime-local') misbehave on chromium-based
  // browsers when a time is set that includes a seconds value of '00', most notably
  // when entered from keyboard input. This behavior is not limited to specific
  // 'step' attribute values, so we always remove the trailing seconds value if the
  // time ends in '00'.

  switch (type) {
    case 'time':
      return value.length === 8 && value.endsWith('00')
        ? value.substring(0, 5)
        : value;
    case 'datetime-local':
      return value.length === 19 && value.endsWith('00')
        ? value.substring(0, 16)
        : value;
    default:
      return value;
  }
}

function countDescendantFrames(batch: RenderBatch, frame: RenderTreeFrame): number {
  const frameReader = batch.frameReader;
  switch (frameReader.frameType(frame)) {
    // The following frame types have a subtree length. Other frames may use that memory slot
    // to mean something else, so we must not read it. We should consider having nominal subtypes
    // of RenderTreeFramePointer that prevent access to non-applicable fields.
    case FrameType.component:
    case FrameType.element:
    case FrameType.region:
      return frameReader.subtreeLength(frame) - 1;
    default:
      return 0;
  }
}

function clearElement(element: Element) {
  let childNode: Node | null;
  while (childNode = element.firstChild) {
    element.removeChild(childNode);
  }
}

function clearBetween(start: Node, end: Node): void {
  const logicalParent = getLogicalParent(start as unknown as LogicalElement);
  if (!logicalParent) {
    throw new Error("Can't clear between nodes. The start node does not have a logical parent.");
  }
  const children = getLogicalChildrenArray(logicalParent);
  const removeStart = children.indexOf(start as unknown as LogicalElement) + 1;
  const endIndex = children.indexOf(end as unknown as LogicalElement);

  // We remove the end component comment from the DOM as we don't need it after this point.
  for (let i = removeStart; i <= endIndex; i++) {
    removeLogicalChild(logicalParent, removeStart);
  }

  // We sanitize the start comment by removing all the information from it now that we don't need it anymore
  // as it adds noise to the DOM.
  start.textContent = '!';
}

function stripOnPrefix(attributeName: string) {
  if (attributeName.startsWith('on')) {
    return attributeName.substring(2);
  }

  throw new Error(`Attribute should be an event name, but doesn't start with 'on'. Value: '${attributeName}'`);
}

function isMultipleSelectElement(element: HTMLSelectElement) {
  return element.type === 'select-multiple';
}

function setSingleSelectElementValue(element: HTMLSelectElement, value: string | null) {
  // There's no sensible way to represent a select option with value 'null', because
  // (1) HTML attributes can't have null values - the closest equivalent is absence of the attribute
  // (2) When picking an <option> with no 'value' attribute, the browser treats the value as being the
  //     *text content* on that <option> element. Trying to suppress that default behavior would involve
  //     a long chain of special-case hacks, as well as being breaking vs 3.x.
  // So, the most plausible 'null' equivalent is an empty string. It's unfortunate that people can't
  // write <option value=@someNullVariable>, and that we can never distinguish between null and empty
  // string in a bound <select>, but that's a limit in the representational power of HTML.
  element.value = value || '';
}

function setMultipleSelectElementValue(element: HTMLSelectElement, value: string[] | null) {
  value ||= [];
  for (let i = 0; i < element.options.length; i++) {
    element.options[i].selected = value.indexOf(element.options[i].value) !== -1;
  }
}

function setDeferredElementValue(element: Element, value: any) {
  if (element instanceof HTMLSelectElement) {
    if (isMultipleSelectElement(element)) {
      setMultipleSelectElementValue(element, value);
    } else {
      setSingleSelectElementValue(element, value);
    }
  } else {
    (element as any).value = value;
  }
}
